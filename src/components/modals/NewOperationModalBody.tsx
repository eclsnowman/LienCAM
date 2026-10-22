import type { CamCommand } from '../../kernel/camCommands'
import { operationAuthoringDecision, type OperationAuthoringFacts } from '../../kernel/authoring'
import { geometryDisplayName, pickedFaceDisplayName, readableInternalIds } from '../../lib/operatorLabels'
import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import {
  ArrowDown, CheckCircle2, ChevronDown, ChevronRight, Circle, Gauge, Hand, Layers, Loader2, MousePointer2, PenTool, Scissors,
  Spline, Square, Tornado, TriangleRight, Waves, Waypoints, Wrench, X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { areaLabel, feedLabel, fmtArea, fmtDim, fmtFeed, fmtMachineLength, parseDimToMm, unitLabel } from '../../lib/ui/unitFormat'
import { deriveModelThreadMillTarget, geometryForOperation, meshFeatureTargetAdmission, operationAcceptsMeshEdgeChains, resolveOpGeometrySources, setupProvenStockId, smartHeightModelTop, smartHeightStockBounds, useCamStore } from '../../store'
import { DisclosureSection } from '../ui/DisclosureSection'
import { NumericInput, OptionalNumericInput } from '../ui/NumericInput'
import { heightOffsetBoxValue } from './useHeightOffsetDisplay'
import { toolHalfAngleRad } from '../../lib/cam/geometry'
import { drillBoreEndAllowancesMm } from '../../lib/cam/smartHeights/drillBore'
import { CLEARANCE_TRIM_OP_TYPES, clearanceAllowanceMmOf } from '../../lib/cam/holderClearanceGate'
import { contourLoopIdsForSave } from '../../lib/cam/contour2d'
import { deriveFaceLoops, deriveSection } from '../../lib/cam/geometry/occt/model/modelClient'
import { DEFAULT_ADAPTIVE3D_PARAMS } from '../../cam3d/integration/adaptive3dOperation'
import { DEFAULT_PARALLEL3D_PARAMS, faceScopeForSource, readFaceScope } from '../../cam3d/integration/parallel3dOperation'
import { DEFAULT_WATERLINE_PARAMS, defaultWaterlineStepdownFor } from '../../cam3d/integration/waterline3dOperation'
import { RoughingScopeSelector } from '../panels/RoughingScopeSelector'
import { deriveHeightPlaneOffsetUpdate, deriveHeightRefUpdate, intentReferenceForUiReference, uiReferenceForIntentReference, type HeightRefOpType, type HeightRefParams } from '../../lib/cam/heightReference'
import {
  isModelOpSourceEligible, isModelOriginGeometry, MODEL_BODY_BINDING_CAPABILITIES,
  resolveOwningModelItemId,
} from '../../lib/cam/modelOrigin'
import { consumeCylinder } from '../../lib/cam/operationGeometry'
import { getPocketEntryPolicy, isPocketEntryAllowed, normalizePocketEntryForFillStrategy, } from '../../lib/cam/pocketEntryPolicy'
import {
  CORNER_RELIEF_STYLES, gentleEngagementLimits, resolveGentleEngagement,
} from '../../lib/cam/cornerRelief2d'
import { resolveTrochoidalGeometry, trochoidalFieldLimits } from '../../lib/cam/trochoidal2d'
import { findThreadByBore, findThreadByMajor, findThreadPreset, THREAD_PRESETS } from '../../lib/cam/threadPresets'
import {
  CONTOUR_ROUGHING_STYLE_LABELS, contourPassParamsForMode, DEFAULT_CONTOUR_TABS, encodeAdaptiveMillingDirection,
  ENGRAVE_STYLE_LABELS,
  resolveAdaptiveMillingDirection,
} from '../../lib/cam/types'
import type {
  BoreParams, ChamferHeightReference, ContourCuttingStrategy, ContourParams, ContourRoughingStyle, CornerReliefStyle,
  EngraveStyle,
  ModelReference, ModelReferenceRole, PocketParams, ThreadMillParams,
} from '../../lib/cam/types'
import { holeBottomWorldZ, isTiltedOffZ, ModelOriginComputeError, OwningStockError, ReferencePlaneError, resolveGeometryZToFrames, resolveGeometryZToFramesModelAwareSafe, resolveModelBottomZ, resolveTopZ, transformLoopPoints } from '../../store/dispatchGeo'
import {
  chamferAngleNote, chamferParamsFromPass, chamferPassesFromModel, chamferStretchOf, modeledChamferRecordOf, modeledChamfersOnPart,
  modeledPassDatum as modeledPassDatumIn, type ChamferFrames, type ChamferFromModelPass, type ChamferSourceGeometry,
  type ModeledChamferLoaders, type ModeledChamferLoop, type ModeledChamfersOnPart,
} from '../../lib/cam/chamferFromModel'
import { loadCachedSTL } from '../../lib/stlCache'
import { loadCachedStep } from '../../lib/stepCache'
import type { FeedrateOverride, HeightParams, HeightPlaneName, HeightReference, ImportedGeometry, Loop2D, MachineActionKind, NestRecord, Operation, PassParams, Setup } from '../../types'
import { MACHINE_ACTION_TYPES, callableMachineMacros, machineActionLabel } from '../../types'
import { RefPlaneSelect } from '../ui/RefPlaneSelect'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { LEGACY_MODEL_ITEM_ID, ensureDocumentArchiveHydrated } from '../../doc/documentHolder'
import { resolveModelReferenceFrame } from '../../lib/cam/modelReferenceFrame'
import {
  heightIntentAfterNumericEdit,
  heightIntentAfterReferenceEdit,
  operationSafetyHeightIntent,
  operationSafetyUserOverridePlanes,
  setupDefaultHeightIntent,
  type OperationSafetyPlane,
} from '../../lib/cam/heightIntent'
import {
  bindUnprovenStockTopSafety,
  buildAdaptive3dSmartIntent,
  buildChamferSmartHeightIntent,
  buildContourSmartHeightIntent,
  buildDrillBoreAuthoringIntent,
  buildEngraveSmartHeightIntent,
  buildVCarveSmartHeightIntent,
  vcarveToolLimitDepthMm,
  buildFaceSmartHeightIntent,
  buildPlanarRoughSmartHeightIntent,
  buildParallel3dSmartIntent,
  buildScallop3dSmartIntent,
  buildPencil3dSmartIntent,
  buildSteepShallow3dSmartIntent,
  buildWaterline3dSmartIntent,
  buildThreadMillSmartHeightIntent,
  deriveContourFeatureBindings,
  deriveChamferEdgeBindings,
  deriveDrillBoreFeatureBindings,
  deriveThreadMillFeatureBindings,
  SMART_HEIGHT_V2_REPAIR_MESSAGE,
  validatePersistedSmartHeightState,
  operatorPlaneOverridesFromState,
  withOperatorPlaneOverrides,
  type AuthoredPlaneIntentV2,
  type OperatorPlaneOverrides,
  type ResolvedHeightPlanV2,
  type StableFeatureReference,
} from '../../lib/cam/smartHeights'
import { deriveModelBodyBoreTarget, deriveModelBodyDrillTargets, deriveModelBodyFace, modelBodyWorldZRange } from '../../lib/cam/modelBodyDerive'
import {
  deriveModelBodyEdges, modelBodyEdgeChainBindingSupported, modelBodyEdgePickOffered,
  modelEdgeChainAllowsOpenPaths, modelEdgeChainBodyMismatch, modelEdgeChainDeriveOptions,
  modelEdgeChainMismatchMessage, modelEdgeChainSourceGeometry, modelReferenceMatchesSource,
} from '../../store/modelEdgeChainBinding'
import { readModelBodyFaceFacts, recognizeModelBodyHoles } from '../../lib/cam/modelBodyHoleRecognition'
import {
  defaultACParams, defaultBoreParams, defaultChamferParams, defaultContourParams,
  defaultDrillParams, defaultEngraveParams, defaultFaceParams, defaultFeedrateOverride,
  defaultHeights, defaultLinking, defaultPasses, defaultPocketParams,
  defaultThreadMillParams, getVp, TABS,
} from './newOperationModalDefaults'
import {
  FACE_PASS_ANGLE_BOUNDS, FACE_PASS_EXTENSION_BOUNDS, FACE_STOCK_OFFSET_BOUNDS,
  FACE_STEPOVER_BOUNDS, FACE_STEPDOWN_BOUNDS, FACE_RADIAL_STOCK_BOUNDS, faceToolDiameterCap,
} from './faceFieldBounds'
import { AutoFromModelBadge, HeightDiagram, NumberField } from './newOperationModalParts'
import { useDrillBreakThroughDefault } from './useDrillBreakThroughDefault'
import type { useNewOperationModalState } from './useNewOperationModalState'
import type { VCarveParams } from '../../lib/cam/types'
import {
  finishMachiningBoundaryPickPresentation,
  isCurrentMachiningBoundaryPick,
  startMachiningBoundaryPickPresentation,
} from './newOperationMachiningBoundaryPickPresentation'
import { ResolvedHeightPlanInspector } from '../cam/ResolvedHeightPlanInspector'
import {
  isMeshChainId,
  isMeshChainInstancePicked,
  isStlChainSource,
  loopSelectionPicks,
  withLoopSelection,
  type LoopSelectionPick,
  type MeshChainSourceBinding,
  type MeshChainSources,
} from '../../lib/cam/meshChainInstances'
// A viewport callback can outlive the render that created it. Keying the active
// session by this modal instance's stable state setter lets stop/reset invalidate
// an old callback synchronously without adding hooks back to the decomposed body.
const activeLoopPickSessions = new WeakMap<object, symbol>()

type PersistedContourParams = ContourParams & {
  meshChainSources?: Record<string, MeshChainSourceBinding[]>
}
/** Pocket carries the same authoring-time chain bindings as Contour. The field
 * is declared here, beside its only writer, rather than widened in the shared
 * param types - the compute seam reads it structurally (WO-258). */
type PersistedPocketParams = PocketParams & {
  meshChainSources?: Record<string, MeshChainSourceBinding[]>
}
/** WO-1378 (BUG-416/BUG-415): role 'flat_clearing' only - the id of the carve
 *  operation this clears for. Sibling lookup and duplicate-ownership key off
 *  this id, never geometryId+loopIds, which matched a duplicated carve's
 *  clearing to the ORIGINAL carve's sibling. Declared here, beside its writer,
 *  same pattern as meshChainSources; store/index.ts reads it structurally
 *  (duplicateOperation, withVcarveClearingOrder). */
type PersistedVCarveParams = VCarveParams & {
  carveOpId?: string
}

type LiveSmartHeightPreview =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'resolved'; plan: ResolvedHeightPlanV2 }
  | { state: 'error'; message: string }

const STANDARD_HEIGHT_ROWS: ReadonlyArray<{
  plane: HeightPlaneName
  label: string
  definition: string
  references: ReadonlyArray<{ value: HeightReference; label: string }>
}> = [
  {
    plane: 'clearance', get label() { return tx('NewOperationModalBody.Clearance_Height') }, get definition() { return tx('NewOperationModalBody.Safe_rapid_plane') },
    references: [
      { value: 'retract', get label() { return tx('NewOperationModalBody.Retract') } },
      { value: 'stock_top', get label() { return tx('NewOperationModalBody.Stock_top') } },
      { value: 'model_top', get label() { return tx('NewOperationModalBody.Model_top') } },
      { value: 'wcs_plane', get label() { return tx('NewOperationModalBody.WCS_Z_absolute') } },
    ],
  },
  {
    plane: 'retract', get label() { return tx('NewOperationModalBody.Retract_Height') }, get definition() { return tx('NewOperationModalBody.Rapid_plane_between_cuts') },
    references: [
      { value: 'feed', get label() { return tx('NewOperationModalBody.Feed_height') } },
      { value: 'top', get label() { return tx('NewOperationModalBody.Top') } },
      { value: 'stock_top', get label() { return tx('NewOperationModalBody.Stock_top') } },
      { value: 'model_top', get label() { return tx('NewOperationModalBody.Model_top') } },
      { value: 'wcs_plane', get label() { return tx('NewOperationModalBody.WCS_Z_absolute') } },
    ],
  },
  {
    plane: 'feed', get label() { return tx('NewOperationModalBody.Feed_Height') }, get definition() { return tx('NewOperationModalBody.Rapid_to_feed_transition') },
    references: [
      { value: 'top', get label() { return tx('NewOperationModalBody.Top') } },
      { value: 'stock_top', get label() { return tx('NewOperationModalBody.Stock_top') } },
      { value: 'model_top', get label() { return tx('NewOperationModalBody.Model_top') } },
      { value: 'wcs_plane', get label() { return tx('NewOperationModalBody.WCS_Z_absolute') } },
    ],
  },
  {
    plane: 'top', get label() { return tx('NewOperationModalBody.Top_Height') }, get definition() { return tx('NewOperationModalBody.Material_start') },
    references: [
      { value: 'stock_top', get label() { return tx('NewOperationModalBody.Stock_top') } },
      { value: 'model_top', get label() { return tx('NewOperationModalBody.Model_top') } },
      { value: 'geometry_plane', get label() { return tx('NewOperationModalBody.Geometry_plane') } },
      { value: 'selected_feature_top', get label() { return tx('NewOperationModalBody.Selected_feature_top') } },
      { value: 'remaining_stock', get label() { return tx('NewOperationModalBody.Remaining_stock') } },
      { value: 'wcs_plane', get label() { return tx('NewOperationModalBody.WCS_Z_absolute') } },
    ],
  },
  {
    plane: 'bottom', get label() { return tx('NewOperationModalBody.Bottom_Height') }, get definition() { return tx('NewOperationModalBody.Machining_end') },
    references: [
      { value: 'top', get label() { return tx('NewOperationModalBody.Top') } },
      { value: 'stock_bottom', get label() { return tx('NewOperationModalBody.Stock_bottom') } },
      { value: 'model_bottom', get label() { return tx('NewOperationModalBody.Model_bottom') } },
      { value: 'geometry_plane', get label() { return tx('NewOperationModalBody.Geometry_plane') } },
      { value: 'selected_feature_bottom', get label() { return tx('NewOperationModalBody.Selected_feature_bottom') } },
      { value: 'picked_surface', get label() { return tx('NewOperationModalBody.Picked_surface') } },
      { value: 'wcs_plane', get label() { return tx('NewOperationModalBody.WCS_Z_absolute') } },
    ],
  },
]

/** Operations whose Top/Bottom Height come from their own Smart Height policy.
 * Their rows take the operator's override (WO-1544). */
const ROW_OVERRIDE_OPERATION_TYPES = new Set<Operation['type']>([
  'parallel_3d', 'waterline_3d', 'steep_shallow_3d', 'scallop_3d', 'pencil_3d', 'adaptive_3d', 'face', 'contour_2d',
  'drill', 'bore', 'pocket_2d', 'adaptive_clearing_2d', 'thread_mill', 'chamfer', 'engrave', 'vcarve',
])
const SMART_ROW_OPTION = '__smart_policy__'
/** WO-1601: a lower height policy selector whose plane the height row sets. */
const HEIGHT_ROW_HELD_OPTION = '__height_row__'

/** WO-1599: a geometry-bound Pocket / Adaptive Clearing end reference, named in
 * the Bottom Height row's vocabulary. Both directions of one state. */
/** WO-3021: the chord a STEP part's chamfer faces are tessellated at, mm. */
const MODELED_CHAMFER_STEP_CHORD_MM = 0.005
/** The store's frame resolvers chamferFromModel places a part's chamfers by. */
const CHAMFER_FRAMES: ChamferFrames = { transformLoopPoints, resolveGeometryZToFramesModelAwareSafe, resolveTopZ }

const PLANAR_BOTTOM_ROW_REFERENCE: Partial<Record<ChamferHeightReference, HeightReference>> = {
  stock_top: 'stock_top',
  stock_bottom: 'stock_bottom',
  geometry_face: 'geometry_plane',
  picked_plane: 'picked_surface',
  wcs_plane: 'wcs_plane',
}
const PLANAR_BOTTOM_END_REFERENCE: Partial<Record<HeightReference, ChamferHeightReference>> = {
  stock_top: 'stock_top',
  stock_bottom: 'stock_bottom',
  geometry_plane: 'geometry_face',
  picked_surface: 'picked_plane',
}
const PLANAR_BOTTOM_ROW_OPTIONS: ReadonlyArray<{ value: HeightReference; label: string }> = [
  { value: 'stock_top', get label() { return tx('NewOperationModalBody.Stock_top') } },
  { value: 'stock_bottom', get label() { return tx('NewOperationModalBody.Stock_bottom') } },
  { value: 'geometry_plane', get label() { return tx('NewOperationModalBody.Geometry_plane') } },
  { value: 'wcs_plane', get label() { return tx('NewOperationModalBody.WCS_Z_absolute') } },
]

function heightReferenceLabel(reference: HeightReference): string {
  for (const option of [...PLANAR_BOTTOM_ROW_OPTIONS, ...STANDARD_HEIGHT_ROWS.flatMap(row => row.references)]) {
    if (option.value === reference) return option.label
  }
  return reference
}

function heightValue(heights: HeightParams, plane: HeightPlaneName): number {
  switch (plane) {
    case 'clearance': return heights.clearanceHeight
    case 'retract': return heights.retractHeight
    case 'feed': return heights.feedHeight
    case 'top': return heights.topHeight
    case 'bottom': return heights.bottomHeight
  }
}

function heightValuePatch(plane: HeightPlaneName, value: number): Partial<HeightParams> {
  switch (plane) {
    case 'clearance': return { clearanceHeight: value }
    case 'retract': return { retractHeight: value }
    case 'feed': return { feedHeight: value }
    case 'top': return { topHeight: value }
    case 'bottom': return { bottomHeight: value, bottomManual: true }
  }
}

function resolvedPlanTargetEndWcs(plan: ResolvedHeightPlanV2): number | undefined {
  if (plan.machining.cutterCenterEnd) return plan.machining.cutterCenterEnd.wcsMm
  const featureEnds = plan.machining.featureEndpoints
    ?.map(endpoint => endpoint.cutterCenterEnd.wcsMm)
    .filter(Number.isFinite)
  if (featureEnds?.length) return Math.min(...featureEnds)
  return plan.machining.physicalTarget?.wcsMm
}

const contourNeedsStockMessage = () =>
  tx('NewOperationModalBody.This_Contour_needs_a_stock_in_its_Setup_add')

function LiveSmartHeightPlan({
  preview,
  idleMessage,
  repairMessage,
}: {
  preview: LiveSmartHeightPreview
  idleMessage: string
  repairMessage?: string | null
}) {
  useText('cam-operations-new-operation')
  if (preview.state === 'idle') return <div className="op-hint">{idleMessage}</div>
  if (preview.state === 'loading') {
    return <div className="op-hint"><Loader2 size={12} className="spin" />{tx('NewOperationModalBody.Resolving_Smart_Height')}</div>
  }
  if (preview.state === 'error') {
    return (
      <ResolvedHeightPlanInspector
        refusal={{ code: 'resolution_refused', message: preview.message }}
        repairMessage={repairMessage ?? SMART_HEIGHT_V2_REPAIR_MESSAGE}
        defaultOpen
      />
    )
  }
  return <ResolvedHeightPlanInspector plan={preview.plan} />
}

/** Counts CLOSED chains on purpose: that is what every chain-consuming family
 * can actually cut a boundary from (WO-258 admits Pocket to closed chains only),
 * so the label never promises a path the operation will refuse. */
function stlChainSourceLabel(geometry: ImportedGeometry): string {
  const loops = geometry.loops ?? []
  const chainLayerIds = new Set((geometry.layers2d ?? [])
    .filter((layer) => layer.derived === true && layer.name === 'STL edge chains')
    .map((layer) => layer.id))
  const chainCount = loops.filter((loop) => loop.closed && chainLayerIds.has(loop.layerId)).length
  if (chainLayerIds.size === 0 && loops.length === 0) {
    return tx('NewOperationModalBody.STL_select_to_load_edge_chains', { p1: geometry.name })
  }
  if (chainLayerIds.size > 0) {
    return tx('NewOperationModalBody.STL_edge_chains', { p1: geometry.name, p2: chainCount })
  }
  const closedLoopCount = loops.filter((loop) => loop.closed).length
  return tx('NewOperationModalBody.closed_loops', { p1: geometry.name, p2: closedLoopCount })
}

/** WO-2859: an imported STL is offered to a family BEFORE anything has been
 * derived from it whenever choosing it can derive what that family cuts: the
 * edge-chain families (WO-251/258) load its chains, and the recognised-hole
 * families (WO-1851: a drill or a bore aims at a proved hole) detect its holes.
 * Before this, a fresh STL reached Drill only once someone had already pressed
 * Detect holes elsewhere - and Drill's own list was the only place to do that.
 * One rule for the dropdown, the viewport pick set and the source label. */
function familyDerivesFromStl(operationType: Operation['type']): boolean {
  return operationAcceptsMeshEdgeChains(operationType) || meshFeatureTargetAdmission(operationType) === 'holes'
}

function stlDerivesOnSelectionFor(
  geometry: ImportedGeometry,
  operationType: Operation['type'],
): boolean {
  return geometry.type === 'mesh' && geometry.format === 'stl' && familyDerivesFromStl(operationType)
}

/** WO-1521: a nest's owned seed copy and the workspace original it was
 * deep-copied from (`deepCopySeedGeometry`, src/store/index.ts) share a name and
 * geometry, so the flat Source geometry dropdown rendered byte-identical rows
 * that differed only by the invisible `value` uuid. Selecting one changes the
 * machining scope (seed = this nest's placements; original = the lone workspace
 * part) with no visible cue. When the entry carries `ownerNestId`, fold the
 * owning NestRecord's name into the label so the two rows read as distinct
 * without a tooltip. No `ownerNestId` (or an unresolvable one) returns exactly
 * today's text. */
function nestSeedSuffix(
  geometry: Pick<ImportedGeometry, 'ownerNestId'>,
  nests: ReadonlyArray<Pick<NestRecord, 'id' | 'name'>> | undefined,
): string {
  if (!geometry.ownerNestId) return ''
  const nest = nests?.find(n => n.id === geometry.ownerNestId)
  return nest ? tx('NewOperationModalBody.seed_of', { p1: nest.name }) : ''
}

/** The viewport offers the same chain-consuming admission the dropdown does
 * (`operationSourceGeometries` below). WO-329: an STL used to stay out of
 * this set until its chains were already derived, which made the dropdown
 * the ONLY door that could ever open for a fresh STL - the viewport picker
 * could never be the first interaction with one. Picking a loopless STL here
 * now derives its chains through the same path the dropdown uses (setGeoId),
 * so both doors open the same lock. */
function isViewportPickableOperationSource(
  geometry: ImportedGeometry,
  operationType: Operation['type'],
): boolean {
  if (isModelOpSourceEligible(geometry)) return true
  if (isModelOriginGeometry(geometry)) return false
  const solidOperation = operationType === 'parallel_3d' || operationType === 'adaptive_3d' ||
    operationType === 'waterline_3d' || operationType === 'steep_shallow_3d'
  return solidOperation
    ? geometry.type === 'mesh' || geometry.type === 'brep'
    : (geometryForOperation(geometry, operationType).loops?.length ?? 0) > 0 || geometry.type === 'brep'
      || stlDerivesOnSelectionFor(geometry, operationType)
}

/** Every newly authored keyed-item reference carries the compound Model
 *  Item/body identity. Omission remains the persisted spelling for the legacy
 *  item only; it is never emitted for a non-legacy source. */
export function authorModelReference(
  modelItemId: string,
  bodyId: string,
  stableIds: readonly string[],
  role: ModelReferenceRole,
): ModelReference {
  return {
    ...(modelItemId === LEGACY_MODEL_ITEM_ID ? {} : { modelItemId }),
    bodyId,
    stableIds: [...stableIds],
    role,
  }
}

function isSafeEnterCreateTarget(target: EventTarget | null, panel: HTMLElement): boolean {
  if (!(target instanceof Element) || !panel.contains(target)) return false
  if (target.closest([
    'button',
    'select',
    'option',
    'textarea',
    'a[href]',
    'summary',
    '[contenteditable]:not([contenteditable="false"])',
    '[aria-multiline="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="menu"]',
    '[role="menuitem"]',
  ].join(','))) return false

  const input = target.closest('input')
  if (!(input instanceof HTMLInputElement)) return true
  return !input.disabled && [
    'text', 'number', 'search', 'email', 'password', 'tel', 'url',
  ].includes(input.type)
}

function OperationModalInteractionGuard({
  isPickingLoops,
  onStopPicking,
  pickerContextKey,
  canCreate,
  onCreate,
  onClose,
}: {
  isPickingLoops: boolean
  onStopPicking(): void
  pickerContextKey: string
  canCreate: boolean
  onCreate(): void
  onClose(): void
}) {
  useText('cam-operations-new-operation')
  const stopPickingRef = useRef(onStopPicking)
  const isPickingLoopsRef = useRef(isPickingLoops)
  const canCreateRef = useRef(canCreate)
  const createRef = useRef(onCreate)
  const closeRef = useRef(onClose)
  const pendingCreateRef = useRef<number | null>(null)
  const pickerContextRef = useRef(pickerContextKey)

  useLayoutEffect(() => {
    // Publish keyboard actions only with the render React just committed. A
    // NumericInput commits during its own keydown handler, so the deferred
    // create below must never retain the pre-commit operation payload.
    stopPickingRef.current = onStopPicking
    isPickingLoopsRef.current = isPickingLoops
    canCreateRef.current = canCreate
    createRef.current = onCreate
    closeRef.current = onClose
  }, [canCreate, isPickingLoops, onClose, onCreate, onStopPicking])

  useLayoutEffect(() => {
    const contextChanged = pickerContextRef.current !== pickerContextKey
    pickerContextRef.current = pickerContextKey
    if (isPickingLoops && contextChanged) {
      // The visible wizard is intentionally usable during picking. If the user
      // changes what the picker means, retire the old viewport callback before
      // paint; they can then explicitly re-arm against the new configuration.
      stopPickingRef.current()
    }
  }, [isPickingLoops, pickerContextKey])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Bubble phase is deliberate: a child control gets first refusal through
      // preventDefault/stopPropagation, and IME confirmation never becomes a
      // modal command.
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return

      if (event.key === 'Escape') {
        if (pendingCreateRef.current !== null) {
          window.clearTimeout(pendingCreateRef.current)
          pendingCreateRef.current = null
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        if (isPickingLoopsRef.current) stopPickingRef.current()
        else closeRef.current()
        return
      }

      if (
        event.key !== 'Enter'
        || isPickingLoopsRef.current
        || !canCreateRef.current
      ) return

      const panel = document.querySelector<HTMLElement>('[data-testid="op-modal-panel"]')
      if (panel === null || !isSafeEnterCreateTarget(event.target, panel)) return

      event.preventDefault()
      event.stopImmediatePropagation()
      if (pendingCreateRef.current !== null) return
      pendingCreateRef.current = window.setTimeout(() => {
        pendingCreateRef.current = null
        // React has now committed any child input draft. Re-check the current
        // modal gates as well as the current create closure before dispatch.
        if (isPickingLoopsRef.current || !canCreateRef.current) return
        createRef.current()
      }, 0)
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (pendingCreateRef.current !== null) {
        window.clearTimeout(pendingCreateRef.current)
        pendingCreateRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!isPickingLoops) return
    const panel = document.querySelector<HTMLDivElement>('[data-testid="op-modal-panel"]')
    const backdrop = document.querySelector<HTMLDivElement>('[data-testid="op-modal-backdrop"]')
    const header = panel?.querySelector<HTMLDivElement>(':scope > .modal-header')
    if (
      panel === null || panel === undefined
      || backdrop === null
      || header === null || header === undefined
    ) return

    // This is the existing nonblocking modal seam. Applying it imperatively
    // keeps the original, already-dispositioned backdrop authoring identity.
    backdrop.classList.add('modal-backdrop-transparent')

    // Keep the complete 680px wizard, but place it at the right edge initially
    // so viewport picking is useful immediately. Its existing header becomes a
    // drag handle only for this nonblocking presentation.
    const positionPanel = (x: number, y: number): void => {
      panel.style.transform = `translate(${x}px, ${y}px)`
    }
    const initialBounds = panel.getBoundingClientRect()
    const initialWidth = initialBounds.width > 0 ? initialBounds.width : 680
    const initialHeight = initialBounds.height > 0 ? initialBounds.height : 600
    const baseLeft = initialBounds.left
    const baseTop = initialBounds.top
    let translateX = Math.max(8, window.innerWidth - initialWidth - 12) - baseLeft
    let translateY = Math.max(8, Math.min(72, window.innerHeight - initialHeight - 8)) - baseTop
    positionPanel(translateX, translateY)

    let drag: {
      pointerId: number
      pointerX: number
      pointerY: number
      translateX: number
      translateY: number
    } | null = null
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('button') !== null) return
      drag = {
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        translateX,
        translateY,
      }
      event.preventDefault()
    }
    const onMove = (event: PointerEvent): void => {
      if (drag === null || drag.pointerId !== event.pointerId) return
      const wantedX = drag.translateX + event.clientX - drag.pointerX
      const wantedY = drag.translateY + event.clientY - drag.pointerY
      translateX = Math.max(8 - baseLeft, Math.min(
        window.innerWidth - initialWidth - 8 - baseLeft,
        wantedX,
      ))
      translateY = Math.max(8 - baseTop, Math.min(
        window.innerHeight - initialHeight - 8 - baseTop,
        wantedY,
      ))
      positionPanel(translateX, translateY)
    }
    const onUp = (event: PointerEvent): void => {
      if (drag?.pointerId === event.pointerId) drag = null
    }
    header.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      drag = null
      header.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      backdrop.classList.remove('modal-backdrop-transparent')
      panel.style.removeProperty('transform')
    }
  }, [isPickingLoops])

  return null
}

// ── Presentational body ───────────────────────────────────────────────────────
// BK-178-DECOMP: the derived-values + JSX render body. Receives the state bundle
// plus the resolved (guaranteed-non-null) setup/isEditMode/setupId as props.
// Its local Run macro choice is initialized before any conditional render.
export function NewOperationModalBody({ state, setup, isEditMode, setupId: _setupId }: {
  state: ReturnType<typeof useNewOperationModalState>
  setup: Setup
  isEditMode: boolean
  setupId: string | null
}) {
  useText('cam-operations-new-operation')
  const [runMacroId, setRunMacroId] = useState('')
  const {
    closeModal, project, toolLibrary, toolLibraries, editingOpPayload, computeToolpath,
    deriveBrepLayer, displayUnits, savedReviewCameraRef, tab, setTab, opType, setOpType,
    machineActionKind, setMachineActionKind,
    opName, setOpName, toolId, setToolId, heights, setHeights, customEndCondition, setCustomEndCondition,
    passes, setPasses, linking, setLinking, contour, setContour,
    contourHeightDraft, setContourHeightDraft, contourHeightAuthority, setContourHeightAuthority,
    pocket, setPocket,
    drill, setDrill, bore, setBore, drillBoreHeightDraft, setDrillBoreHeightDraft,
    drillBoreHeightAuthority, setDrillBoreHeightAuthority, threadMill, setThreadMill, chamfer, setChamfer,
    face, setFace, engrave, setEngrave, engraveExplicitDepthMm, setEngraveExplicitDepthMm,
    engraveDepthConfirmed: engraveDepthEntered, setEngraveDepthConfirmed: setEngraveDepthEntered,
    vcarve, setVCarve, vcarveClearingToolId, setVCarveClearingToolId,
    adaptive, setAdaptive, parallel3d, setParallel3d,
    parallel3dPartId, setParallel3dPartId, parallel3dHeightAuthority, setParallel3dHeightAuthority,
    waterline3d, setWaterline3d, waterline3dPartId, setWaterline3dPartId, setWaterline3dHeightAuthority,
    steepShallow3d, setSteepShallow3d, steepShallow3dPartId, setSteepShallow3dPartId,
    scallop3d, setScallop3d, scallop3dPartId, setScallop3dPartId,
    pencil3d, setPencil3d, pencil3dPartId, setPencil3dPartId,
    adaptive3d, setAdaptive3d, adaptive3dPartId, setAdaptive3dPartId,
    adaptive3dHeightDraft, setAdaptive3dHeightDraft, adaptive3dHeightAuthority, setAdaptive3dHeightAuthority,
    faceHeightDraft, setFaceHeightDraft, faceHeightAuthority, setFaceHeightAuthority,
    faceHeightConfirmed, setFaceHeightConfirmed,
    isPickingSourcePart, setIsPickingSourcePart,
    isPickingLoops, setIsPickingLoops, toolFilterSearch, setToolFilterSearch, toolFilterUsedOnly, setToolFilterUsedOnly, toolFilterLibraryId, setToolFilterLibraryId,
    reviewingHoleLoopId, setReviewingHoleLoopId, setSavedReviewPickedLoopIds, userClearedLoops, setUserClearedLoops, brepPickKind, setBrepPickKind,
    brepFacePicks, setBrepFacePicks, brepFaceTypes, setBrepFaceTypes, brepEdgePicks, setBrepEdgePicks, brepDeriving, setBrepDeriving,
    brepDeriveError, setBrepDeriveError, editLoadError, setEditLoadError,
    heightRepairMessage, setHeightRepairMessage,
    brepFaceDepthHint, setBrepFaceDepthHint, brepSectionZStr, setBrepSectionZStr,
    isScrubbingSectionZ, setIsScrubbingSectionZ, feedrateOverride, setFeedrateOverride, machiningBoundaryFace, setMachiningBoundaryFace, machiningBoundaryPickActive, setMachiningBoundaryPickActive,
    machiningBoundaryPickError, setMachiningBoundaryPickError, modelDrillBinding, setModelDrillBinding, modelBoreBinding, setModelBoreBinding, contourMode, setContourMode,
    modelEdgeChain, setModelEdgeChain, modelEdgePicks, setModelEdgePicks, modelEdgePickError, setModelEdgePickError,
    modelEdgeMigratedIds, setModelEdgeMigratedIds,
    stopHoleReview,
  } = state
  const previewSmartHeightPlanFromStore = useCamStore(s => s.previewOperationSmartHeightPlan)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // WO-257: ONE selection model, not two. A live viewport pick session keeps a
  // mutable accepted set (see startLoopPicking) so a hit can be refused and the
  // highlight restored synchronously. Every OTHER surface that changes the
  // picked set - the loop checkboxes, All loops / Unselect all, the derived
  // layer buttons - must write through that same set, or the next viewport
  // click recomputes from a snapshot taken before the list was touched and
  // silently drops what the list picked. Null when no session is active, which
  // makes pushPickedLoopsToViewport identical to the bare setPickedLoops call
  // it replaces.
  const loopPickAcceptedRef = useRef<Set<string> | null>(null)
  // WO-329: the source-part-pick banner closes the instant a viewport pick
  // lands, before an async mesh-chain derive it triggered has settled - with
  // no indicator the operator sees nothing change for a beat, the same
  // complaint in a new costume. Cleared on both success and failure; the
  // failure case hands off to the brepDeriveError message below it.
  const [isDerivingPickedSourcePart, setIsDerivingPickedSourcePart] = useState(false)
  // Same shape as isDerivingPickedSourcePart above, for the model-bore face
  // pick: true only while a picked face's kernel-mount/face-facts round trip
  // is in flight, so the banner can tell the operator the click registered
  // (WO-335 audit).
  const [isModelBorePickResolving, setIsModelBorePickResolving] = useState(false)
  const [expandedHeightPlane, setExpandedHeightPlane] = useState<HeightPlaneName | null>(null)

  /** Set the viewport's picked loops AND the live pick session's accepted set. */
  const pushPickedLoopsToViewport = (loopIds: string[]) => {
    const accepted = loopPickAcceptedRef.current
    if (accepted) {
      accepted.clear()
      for (const id of loopIds) accepted.add(id)
    }
    getVp()?.setPickedLoops?.(loopIds)
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const selectedTool  = toolLibrary.find(t => t.id === toolId)
  const isPocket      = opType === 'pocket_2d'
  const isDrill       = opType === 'drill'
  const isBore        = opType === 'bore'
  const isThreadMill  = opType === 'thread_mill'
  const isChamfer     = opType === 'chamfer'
  const isFace        = opType === 'face'
  const isEngrave     = opType === 'engrave'
  const isVCarve      = opType === 'vcarve'
  const isAdaptive    = opType === 'adaptive_clearing_2d'
  const isContour     = opType === 'contour_2d'
  const isParallel3d  = opType === 'parallel_3d'
  const isWaterline3d = opType === 'waterline_3d'
  const isSteepShallow3d = opType === 'steep_shallow_3d'
  const isScallop3d = opType === 'scallop_3d'
  const isPencil3d = opType === 'pencil_3d'
  const contourPathType = contour.pathType ?? 'closed'

  // parallel_3d source: imported SOLID geometries (STL mesh or STEP brep). When
  // exactly one exists it is the default selection (no hook — a derived value so
  // hooks order is untouched); an explicit pick overrides.
  // INT-17A B6: model-backed entries were read-only through INT-17A Stage 1 (no
  // ops on modeled geometry). The `g.type === 'model'` values excluded them from
  // this mesh/brep filter by construction; the exclusion was stated EXPLICITLY
  // on the model-origin marker so it survived a future type change.
  // INT-17C Stage C1 step 3d: was a raw `g.format !== 'model'` string literal
  // (preflight GO/NO-GO finding 5) - unified onto the shared `isModelOriginGeometry`
  // predicate so a future rename/generalization of the origin marker cannot
  // silently miss this site.
  // CAM-BINDING Stage 1: the op-picker gate opens. A model-origin body is now a
  // legal SOURCE (isModelOpSourceEligible, whole-body granularity) even though
  // it still cannot COMPUTE (Stage 2) - selecting one lands the op in the
  // 'unsupported' status instead of producing a toolpath. Every OTHER
  // model-origin consumer (stock, delete, nest aggregate) is untouched: this
  // file's own stock-assignment/delete paths still call `isModelOriginGeometry`
  // directly, never this narrower predicate.
  const parallel3dSolids = project.geometry.filter(
    g => isModelOpSourceEligible(g) || (!isModelOriginGeometry(g) && (g.type === 'mesh' || g.type === 'brep')),
  )
  // Every 2D/2.5D operation shares this exact source domain. Keeping it outside
  // the render branch lets viewport picking and the fallback list use one rule.
  // Stage 1: OR in the same model-source eligibility as parallel3dSolids above -
  // a model-origin body has no `loops` yet (Stage 2/5 build loop derivation), so
  // without the OR it would never pass the loops/brep test on its own. WO-251:
  // Contour also admits imported STL before its cached feature chains have been
  // loaded, so the source remains reachable from the otherwise-empty dialog.
  // WO-258: that admission is the SHARED predicate, not an op-type literal -
  // Pocket joins Contour here by joining the one rule, and geometryForOperation
  // above still decides which of the loaded chains this family may see.
  // WO-2859: Drill and Bore join through `stlDerivesOnSelectionFor` - choosing
  // the STL detects its holes the way choosing it for Contour loads its chains.
  const operationSourceGeometries = project.geometry.filter(
    g => {
      const operationLoops = geometryForOperation(g, opType).loops ?? []
      return isModelOpSourceEligible(g) || (!isModelOriginGeometry(g) && (
        operationLoops.length > 0 || g.type === 'brep'
        || stlDerivesOnSelectionFor(g, opType)
      ))
    },
  )
  // When exactly one imported solid exists it is the default source for BOTH 3D
  // strategies (an explicit pick overrides). BK-178-DECOMP: was inlined twice.
  const singleSolidDefaultId = parallel3dSolids.length === 1 ? parallel3dSolids[0].id : ''
  const parallel3dPartIdEff = parallel3dPartId || singleSolidDefaultId
  const steepShallow3dPartIdEff = steepShallow3dPartId || singleSolidDefaultId
  const scallop3dPartIdEff = scallop3dPartId || singleSolidDefaultId
  const pencil3dPartIdEff = pencil3dPartId || singleSolidDefaultId
  const parallelHeightPartIdEff = isSteepShallow3d
    ? steepShallow3dPartIdEff : isScallop3d ? scallop3dPartIdEff : isPencil3d ? pencil3dPartIdEff : parallel3dPartIdEff
  const parallelHeightFinishDepth = isSteepShallow3d
    ? steepShallow3d.finishDepth : isScallop3d ? scallop3d.finishDepth : isPencil3d ? pencil3d.finishDepth : parallel3d.finishDepth
  // WO-1641: a 3D finish carries no rest opt-in. Every finish plans from the
  // material the enabled earlier operations left; there is nothing to persist.
  const withRestMachining = (params: object): Record<string, unknown> => withFaceScope(params)
  // WO-1223: stamp the face scope onto any 3D-finish params record on its way to
  // the operation. A function DECLARATION so it is hoisted above the arrow
  // above; `faceScope` is declared with the other state below and is only read
  // when this is actually called.
  function withFaceScope(params: object): Record<string, unknown> {
    const next = { ...(params as Record<string, unknown>) }
    if (faceScope.length > 0) next.faceScope = { faceIds: [...faceScope].sort((a, b) => a - b) }
    else delete next.faceScope
    return next
  }
  const editingOperation = isEditMode && editingOpPayload
    ? setup.operations.find(candidate => candidate.id === editingOpPayload.opId)
    : undefined
  // WO-1566: the clearance the toolpath keeps between the neck, shank or holder
  // and the part or the remaining stock (WO-1565). One field on every 2D
  // operation (the ones whose toolpath goes through the worker's clearance
  // trim); saved into params so the compute seam reads it structurally - the
  // same pattern as the contour/pocket meshChainSources above.
  const [shankClearanceMm, setShankClearanceMm] = useState<number>(() =>
    clearanceAllowanceMmOf(editingOperation?.params))
  useEffect(() => {
    setShankClearanceMm(clearanceAllowanceMmOf(editingOperation?.params))
  }, [editingOperation?.id, isEditMode])
  const showsShankClearance = CLEARANCE_TRIM_OP_TYPES.has(opType)
  const withShankClearance = <T extends { params?: Record<string, unknown> }>(operation: T): T =>
    showsShankClearance && operation.params
      ? { ...operation, params: { ...operation.params, clearanceAllowanceMm: shankClearanceMm } }
      : operation
  const [userSafetyOverridePlanes, setUserSafetyOverridePlanes] =
    useState<Set<OperationSafetyPlane>>(() => operationSafetyUserOverridePlanes(editingOperation))
  useEffect(() => {
    setUserSafetyOverridePlanes(operationSafetyUserOverridePlanes(editingOperation))
  }, [editingOperation?.id, isEditMode])
  // WO-1544: the operator's own Top/Bottom Height from the height rows. It rides
  // every draft and saved Smart Height authority, so preview, Save and compute
  // resolve the same number.
  const [rowPlaneOverrides, setRowPlaneOverrides] = useState<OperatorPlaneOverrides>(() =>
    operatorPlaneOverridesFromState(editingOperation?.smartHeight))
  useEffect(() => {
    setRowPlaneOverrides(operatorPlaneOverridesFromState(editingOperation?.smartHeight))
  }, [editingOperation?.id, isEditMode])
  const setRowPlaneOverride = (plane: 'top' | 'bottom', authored: AuthoredPlaneIntentV2 | undefined) =>
    setRowPlaneOverrides(current => {
      if (!authored && !current[plane]) return current
      const next = { ...current }
      if (authored) next[plane] = authored
      else delete next[plane]
      return next
    })
  const withRowHeightOverrides = <T extends Partial<Operation>>(operation: T): T =>
    operation.type && ROW_OVERRIDE_OPERATION_TYPES.has(operation.type) && operation.smartHeight
      ? { ...operation, smartHeight: withOperatorPlaneOverrides(operation.smartHeight, rowPlaneOverrides) }
      : operation
  // Changes exactly when the overrides do, which re-runs every live preview
  // effect that lists it.
  const previewOperationSmartHeightPlan = useCallback(
    (...args: Parameters<typeof previewSmartHeightPlanFromStore>) => {
      const [previewSetupId, operation, ...rest] = args
      return previewSmartHeightPlanFromStore(previewSetupId, withRowHeightOverrides(operation), ...rest)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewSmartHeightPlanFromStore, rowPlaneOverrides],
  )
  // WO-1223: the BRep faces this finishing pass is aimed at, stored WITH the
  // solid they were picked on. Empty = the whole part, which is what a
  // brand-new operation starts as and what every operation authored before this
  // shipped keeps. The pair is kept together because a face id is an index into
  // ONE part's BRep: `faceScopeForSource` below is the single place that decides
  // whether it is still live, so switching the source solid reads AND saves as
  // the whole part in the same breath.
  const [faceScopePick, setFaceScopePick] = useState<{ partId: string; faceIds: number[] }>(() => ({
    partId: editingOperation?.geometrySelections?.[0] ?? '',
    faceIds: readFaceScope(editingOperation?.params ?? {}) ?? [],
  }))
  useEffect(() => {
    setFaceScopePick({
      partId: editingOperation?.geometrySelections?.[0] ?? '',
      faceIds: readFaceScope(editingOperation?.params ?? {}) ?? [],
    })
  }, [editingOperation?.id, isEditMode])
  const operationSafetyIntent = operationSafetyHeightIntent(
    heights.heightIntent ?? setupDefaultHeightIntent(setup),
    userSafetyOverridePlanes,
  )
  const markUserSafetyOverride = (plane: HeightPlaneName) => {
    if (plane !== 'clearance' && plane !== 'retract' && plane !== 'feed') return
    setUserSafetyOverridePlanes(current => {
      if (current.has(plane)) return current
      const next = new Set(current)
      next.add(plane)
      return next
    })
  }
  const buildParallel3dSmartHeightAuthority = () => ({
    kind: 'smart_v2' as const,
    intent: buildParallel3dSmartIntent({
      setupId: setup.id,
      geometryIds: parallel3dPartIdEff ? [parallel3dPartIdEff] : [],
      safetyIntent: operationSafetyIntent,
      finishDepthMm: parallel3d.finishDepth,
    }),
  })
  const buildSteepShallow3dSmartHeightAuthority = () => ({
    kind: 'smart_v2' as const,
    intent: buildSteepShallow3dSmartIntent({
      setupId: setup.id,
      geometryIds: steepShallow3dPartIdEff ? [steepShallow3dPartIdEff] : [],
      safetyIntent: operationSafetyIntent,
      finishDepthMm: steepShallow3d.finishDepth,
    }),
  })
  const buildScallop3dSmartHeightAuthority = () => ({
    kind: 'smart_v2' as const,
    intent: buildScallop3dSmartIntent({
      setupId: setup.id,
      geometryIds: scallop3dPartIdEff ? [scallop3dPartIdEff] : [],
      safetyIntent: operationSafetyIntent,
      finishDepthMm: scallop3d.finishDepth,
    }),
  })
  const buildPencil3dSmartHeightAuthority = () => ({
    kind: 'smart_v2' as const,
    intent: buildPencil3dSmartIntent({
      setupId: setup.id,
      geometryIds: pencil3dPartIdEff ? [pencil3dPartIdEff] : [],
      safetyIntent: operationSafetyIntent,
      finishDepthMm: pencil3d.finishDepth,
    }),
  })
  // waterline_3d (WO-1176) shares the solid picker and the target-field height
  // policy with the raster finish; only the family name and the params differ.
  const waterline3dPartIdEff = waterline3dPartId || singleSolidDefaultId
  const buildWaterline3dSmartHeightAuthority = () => ({
    kind: 'smart_v2' as const,
    intent: buildWaterline3dSmartIntent({
      setupId: setup.id,
      geometryIds: waterline3dPartIdEff ? [waterline3dPartIdEff] : [],
      safetyIntent: operationSafetyIntent,
      finishDepthMm: waterline3d.finishDepth,
    }),
  })
  // ---- WO-1223: "Faces to machine", shown in the Geometry tab -------------
  //
  // The reading is the point: a finishing operation says out loud whether it is
  // aimed at the whole part or at chosen faces, in the tab where its source
  // solid is chosen -- no extra panel and no notice (COHESION-STANDARD s13).
  // Faces are PICKED on the part in the viewport (operation properties, where
  // the viewport is visible); this form adopts whatever is picked there and can
  // send the operation back to the whole part.
  const brepSelections = useCamStore(state => state.viewer.brepSelections)
  const faceScopeSourceId = isWaterline3d ? waterline3dPartIdEff : parallelHeightPartIdEff
  const faceScopeSourceGeo = faceScopeSourceId
    ? parallel3dSolids.find(g => g.id === faceScopeSourceId)
    : undefined
  // Only a STEP solid carries BRep faces; an STL is a triangle soup with none.
  const faceScopeSupported = faceScopeSourceGeo?.format === 'step'
  // THE scope this form is allowed to show and to save right now. Not the state
  // -- the state still remembers which solid its ids came from, so switching
  // away and back does not silently reinterpret them against the wrong part.
  const faceScope = faceScopeForSource(faceScopePick, {
    id: faceScopeSourceId, format: faceScopeSourceGeo?.format,
  })
  const faceScopePicked = faceScopeSourceId
    ? [...new Set(brepSelections
        .filter(sel => sel.kind === 'face' && sel.geoId === faceScopeSourceId)
        .map(sel => sel.index))].sort((a, b) => a - b)
    : []
  const faceScopeBlock = (
    <div data-testid="op-face-scope">
      <p className="op-section-label" style={{ marginTop: 10 }}>{tx('NewOperationModalBody.Faces_to_machine')}</p>
      {/* Reading on the left, actions on the right, one line. The reading takes
          the slack and ellipsises; the buttons size to their own text so
          neither can be squeezed into a two-line stack. */}
      <div className="mform-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span
          data-testid="op-face-scope-reading"
          style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {faceScope.length > 0
            ? tx('NewOperationModalBody.Census_face', { p1: faceScope.length, p2: faceScope.length === 1 ? '' : tx('NewOperationModalBody.Census_s'), p3: faceScope.join(', ') })
            : tx('NewOperationModalBody.All_faces')}
        </span>
        <button
          type="button"
          className="op-pick-btn"
          style={{ width: 'auto', flex: '0 0 auto', marginBottom: 0, whiteSpace: 'nowrap' }}
          data-testid="op-face-scope-use-picked"
          disabled={!faceScopeSupported || faceScopePicked.length === 0}
          onClick={() => setFaceScopePick({ partId: faceScopeSourceId, faceIds: faceScopePicked })}
          title={!faceScopeSupported
            ? tx('NewOperationModalBody.This_part_is_a_mesh_with_no_BRep_faces')
            : faceScopePicked.length === 0
              ? tx('NewOperationModalBody.Click_faces_on_the_part_in_the_viewport_first')
              : tx('NewOperationModalBody.Aim_this_pass_at_face', { p1: faceScopePicked.length === 1 ? '' : tx('NewOperationModalBody.Census_s'), p2: faceScopePicked.join(', ') })}
        >
          <MousePointer2 size={14} />
          {faceScopePicked.length === 0
            ? tx('NewOperationModalBody.Use_picked_faces')
            : tx('NewOperationModalBody.Use_picked_face', { p1: faceScopePicked.length, p2: faceScopePicked.length === 1 ? '' : tx('NewOperationModalBody.Census_s') })}
        </button>
        {faceScope.length > 0 && (
          <button
            type="button"
            className="op-pick-btn"
            style={{ width: 'auto', flex: '0 0 auto', marginBottom: 0, whiteSpace: 'nowrap' }}
            data-testid="op-face-scope-clear"
            onClick={() => setFaceScopePick({ partId: faceScopeSourceId, faceIds: [] })}
          >
            <X size={14} />{tx('NewOperationModalBody.Whole_part')}</button>
        )}
      </div>
    </div>
  )

  // toolToCutterSpec supports only flat / ball / bull-nose end mills (M1). The 3D
  // finish (parallel_3d) and 3D rough (adaptive_3d) share this exact cutter
  // family, so both gate on this ONE derived flag (BK-178-DECOMP: was two
  // byte-identical booleans parallel3dToolOk / adaptive3dToolOk).
  const cutter3dSupported = !!selectedTool &&
    (selectedTool.type === 'flat_end_mill' ||
     selectedTool.type === 'ball_end_mill' ||
     selectedTool.type === 'bull_nose')
  // WO-1976: Parallel finish alone also takes a V-bit (WO-1971 cone drop). Scallop,
  // pencil, rest, 3D rough and waterline (OCL has no V-bit model) still refuse it
  // in their engines, and Steep/Shallow's waterline half does too - so they keep
  // the end-mill-only gate above rather than let Create lead to a failed compute.
  const parallelCutterSupported = cutter3dSupported || selectedTool?.type === 'v_bit'
  const pencilCutterSupported = !!selectedTool &&
    (selectedTool.type === 'ball_end_mill' || selectedTool.type === 'bull_nose')

  // adaptive_3d source: the shared 3D SOLID list includes imported STL/STEP
  // and LienCAM-modeled bodies. Keep an adaptive-scoped effective part id (the
  // cutter-family check is the shared cutter3dSupported above).
  const isAdaptive3d  = opType === 'adaptive_3d'
  const adaptive3dPartIdEff = adaptive3dPartId || singleSolidDefaultId
  const heightRepairRequired = isEditMode && heightRepairMessage !== null
  const parallel3dSmartHeightForSave = (): Operation['smartHeight'] =>
    heightRepairRequired
      ? (() => { throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE) })()
      : buildParallel3dSmartHeightAuthority()
  const waterline3dSmartHeightForSave = (): Operation['smartHeight'] =>
    heightRepairRequired
      ? (() => { throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE) })()
      : buildWaterline3dSmartHeightAuthority()
  const [planarStockSmartOptIn, setPlanarStockSmartOptIn] = useState(false)
  const [planarGeometrySmartOptIn, setPlanarGeometrySmartOptIn] = useState(false)
  const planarRoughOperationType = isPocket
    ? 'pocket_2d' as const
    : 'adaptive_clearing_2d' as const
  const planarRoughUsesStockBoundary =
    (isPocket && pocket.boundarySource === 'stock') ||
    (isAdaptive && adaptive.boundarySource === 'stock')
  const planarRoughParams = isPocket ? pocket : adaptive
  const planarRoughGeometryId = planarRoughParams.geometryId?.trim() ?? ''
  // WO-405: under "All Parts" the boundary is bound to the STL the picked chain
  // came from (WO-258: params.geometryId stays '__all__', meshChainSources and
  // the picked loops carry the binding). The V2 scope names that ONE geometry:
  // the first source owning a picked chain - the part the chain was picked from.
  // WO-2859: two copies of one STL share chain ids, so "owning" means the part
  // instance the pick is bound to, never merely the first part carrying the id.
  const planarRoughMeshChainPicks = (planarRoughParams as { meshChainSources?: MeshChainSources }).meshChainSources
  const planarRoughAllPartsBoundGeometryId = useMemo(() => {
    if (!(isPocket || isAdaptive) || planarRoughGeometryId !== '__all__') return ''
    if (planarRoughParams.boundarySource === 'stock') return ''
    const pickedIds = planarRoughParams.loopIds ?? []
    if (pickedIds.length === 0) return ''
    const source = resolveOpGeometrySources(project.geometry, '__all__', planarRoughOperationType)
      .find(geometry => (geometry.loops ?? []).some(loop =>
        isMeshChainInstancePicked(pickedIds, planarRoughMeshChainPicks, loop.id, geometry.id)))
    return source?.id ?? ''
  }, [isPocket, isAdaptive, planarRoughGeometryId, planarRoughParams.boundarySource, planarRoughParams.loopIds, planarRoughMeshChainPicks, planarRoughOperationType, project.geometry])
  const planarRoughScopeGeometryId = planarRoughGeometryId === '__all__'
    ? planarRoughAllPartsBoundGeometryId
    : planarRoughGeometryId
  const planarRoughUsesGeometryScope = (isPocket || isAdaptive) &&
    planarRoughParams.boundarySource !== 'stock' &&
    planarRoughScopeGeometryId !== ''
  const planarRoughGeometryMode = heights.bottomHeightMode === 'selected_face' ||
      (planarRoughParams.heightReference ?? 'geometry_face') === 'geometry_face'
    ? 'geometry_floor' as const
    : (planarRoughParams.heightReference ?? 'geometry_face') === 'stock_bottom' &&
        (planarRoughParams.planeOffset ?? 0) < 0
      ? 'through_stock' as const
      : 'explicit_depth' as const
  const planarRoughGeometryTargetLabel = planarRoughGeometryMode === 'geometry_floor'
    ? tx('NewOperationModalBody.the_selected_geometry_floor')
    : planarRoughGeometryMode === 'through_stock'
      ? tx('NewOperationModalBody.the_proven_through_stock_endpoint')
      : tx('NewOperationModalBody.the_explicit_target_plane')
  const editingPlanarAuthority = editingOperation?.smartHeight === undefined
    ? undefined
    : validatePersistedSmartHeightState(editingOperation.smartHeight)
  const editingPlanarUsesSmartV2 = editingPlanarAuthority?.ok === true &&
    editingPlanarAuthority.state.kind === 'smart_v2'
  // A missing V2 policy is repair-required until the operator explicitly
  // chooses the stock or geometry policy.
  const planarStockSmartActive = (isPocket || isAdaptive) && planarRoughUsesStockBoundary && (
    !isEditMode || editingPlanarUsesSmartV2 || planarStockSmartOptIn
  )
  // Geometry-bound repair uses the same explicit boundary choice.
  const planarGeometrySmartActive = planarRoughUsesGeometryScope && (
    !isEditMode || editingPlanarUsesSmartV2 || planarGeometrySmartOptIn
  )
  const planarRoughOwningStockId = setupProvenStockId(setup, project)
  const buildPlanarStockSmartHeightAuthority = useCallback(() => {
    if (!planarRoughOwningStockId) {
      throw new Error(tx('NewOperationModalBody.Smart_stock_roughing_requires_one_proven_stock_assigned_to'))
    }
    return {
      kind: 'smart_v2' as const,
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: setup.id,
        operationType: planarRoughOperationType,
        safetyIntent: operationSafetyIntent,
        mode: 'stock_rough',
        stockId: planarRoughOwningStockId,
      }),
    }
  }, [heights.heightIntent, planarRoughOperationType, planarRoughOwningStockId, setup])
  const buildPlanarGeometrySmartHeightAuthority = useCallback(() => {
    if (!planarRoughScopeGeometryId) {
      throw new Error(planarRoughGeometryId === '__all__'
        ? tx('NewOperationModalBody.Smart_geometry_bound_roughing_under_All_Parts_needs_a')
        : tx('NewOperationModalBody.Smart_geometry_bound_roughing_requires_one_selected_boundary_geometry'))
    }
    return {
      kind: 'smart_v2' as const,
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: setup.id,
        operationType: planarRoughOperationType,
        safetyIntent: operationSafetyIntent,
        mode: planarRoughGeometryMode,
        geometryIds: [planarRoughScopeGeometryId],
        throughAllowanceMm: planarRoughGeometryMode === 'through_stock'
          ? Math.max(0, -(planarRoughParams.planeOffset ?? 0))
          : undefined,
        explicitTargetWcsMm: planarRoughGeometryMode === 'explicit_depth'
          ? planarRoughExplicitTargetWcs()
          : undefined,
      }),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    heights.bottomHeight, heights.heightIntent, planarRoughGeometryId, planarRoughScopeGeometryId,
    planarRoughGeometryMode, planarRoughOperationType, planarRoughParams, project, setup,
  ])
  // WO-1599: the explicit bottom of cut of a geometry-bound Pocket / Adaptive
  // Clearing is its end reference plus offset - the one state End condition,
  // the Bottom Height row and the saved authority all read. It used to read the
  // legacy heights.bottomHeight, which only an absolute Z ever wrote, so "Depth
  // from stock top 5" on a 20 mm stock cut to WCS -5.
  function planarRoughExplicitTargetWcs(): number | undefined {
    const reference = planarRoughParams.heightReference ?? 'geometry_face'
    if (reference === 'absolute') return heights.bottomHeight
    // Stock top/bottom are the Setup's proven stock - the stock the plan names.
    const stockBounds = (reference === 'stock_top' || reference === 'stock_bottom') && planarRoughOwningStockId
      ? smartHeightStockBounds(project, planarRoughOwningStockId)
      : null
    if (stockBounds) {
      const stockMachineZ = reference === 'stock_top' ? stockBounds.max.z : stockBounds.min.z
      return stockMachineZ - setup.wcs.origin.z + (planarRoughParams.planeOffset ?? 0)
    }
    return resolveRefZ(
      reference, planarRoughParams.planeOffset ?? 0, planarRoughParams.geometryId ?? '', planarRoughParams.loopIds ?? [],
    )
  }
  const planarSmartHeightForSave = (
    boundarySource: 'geometry' | 'stock' | undefined,
  ): Operation['smartHeight'] => {
    if (boundarySource === 'stock' && planarStockSmartActive) {
      return buildPlanarStockSmartHeightAuthority()
    }
    if (boundarySource !== 'stock' && planarGeometrySmartActive) {
      return buildPlanarGeometrySmartHeightAuthority()
    }
    throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE)
  }
  const [planarRoughHeightPreview, setPlanarRoughHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    const planarSmartActive = planarStockSmartActive || planarGeometrySmartActive
    if (!planarSmartActive) {
      const idleHandle = window.setTimeout(() => {
        setPlanarRoughHeightPreview({ state: 'idle' })
      }, 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setPlanarRoughHeightPreview({ state: 'loading' })
      try {
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__planar-rough-smart-height-preview__',
            enabled: true,
            status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Smart_planar_rough_preview'),
          type: planarRoughOperationType,
          toolId,
          geometrySelections: planarGeometrySmartActive
            ? [...(planarRoughParams.loopIds ?? [])]
            : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: (planarGeometrySmartActive
            ? { ...planarRoughParams, boundarySource: 'geometry' }
            : { ...planarRoughParams, boundarySource: 'stock', geometryId: '', loopIds: [] }
          ) as unknown as Record<string, unknown>,
          smartHeight: planarGeometrySmartActive
            ? buildPlanarGeometrySmartHeightAuthority()
            : buildPlanarStockSmartHeightAuthority(),
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft).then(
          plan => {
            if (current) setPlanarRoughHeightPreview({ state: 'resolved', plan })
          },
          error => {
            if (current) setPlanarRoughHeightPreview({
              state: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setPlanarRoughHeightPreview({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 250)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  }, [
    adaptive, editingOperation, feedrateOverride, heights, isPocket, linking, opName,
    passes, planarGeometrySmartActive, planarRoughOperationType, planarRoughOwningStockId,
    planarRoughParams, planarStockSmartActive, buildPlanarGeometrySmartHeightAuthority,
    buildPlanarStockSmartHeightAuthority, pocket, previewOperationSmartHeightPlan, setup, toolId,
  ])
  const adaptive3dBandValid = adaptive3dHeightDraft.mode !== 'bounded_band' || (
    Number.isFinite(adaptive3dHeightDraft.topWcsMm) &&
    Number.isFinite(adaptive3dHeightDraft.bottomWcsMm) &&
    adaptive3dHeightDraft.topWcsMm >= adaptive3dHeightDraft.bottomWcsMm
  )
  const [adaptive3dHeightPreview, setAdaptive3dHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if (!isAdaptive3d || !adaptive3dPartIdEff || !toolId ||
        heightRepairRequired || !adaptive3dBandValid) {
      const idleHandle = window.setTimeout(() => {
        setAdaptive3dHeightPreview({ state: 'idle' })
      }, 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setAdaptive3dHeightPreview({ state: 'loading' })
      try {
        const smartHeight = {
          kind: 'smart_v2' as const,
          intent: buildAdaptive3dSmartIntent({
            setupId: setup.id,
            geometryIds: [adaptive3dPartIdEff],
            safetyIntent: operationSafetyIntent,
            mode: adaptive3dHeightDraft.mode,
            boundedBand: adaptive3dHeightDraft.mode === 'bounded_band'
              ? adaptive3dHeightDraft
              : undefined,
          }),
        }
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__adaptive3d-smart-height-preview__',
            enabled: true,
            status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_3D_Rough_preview'),
          type: 'adaptive_3d',
          toolId,
          geometrySelections: [adaptive3dPartIdEff],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: adaptive3d as unknown as Record<string, unknown>,
          smartHeight,
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft).then(
          plan => { if (current) setAdaptive3dHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setAdaptive3dHeightPreview({
              state: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setAdaptive3dHeightPreview({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 250)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  }, [
    adaptive3d, adaptive3dBandValid, adaptive3dHeightAuthority, adaptive3dHeightDraft,
    adaptive3dPartIdEff, editingOperation, feedrateOverride, heights, isAdaptive3d,
    heightRepairRequired, linking, opName, passes, previewOperationSmartHeightPlan, setup, toolId,
  ])

  const [parallel3dHeightPreview, setParallel3dHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if ((!isParallel3d && !isSteepShallow3d && !isScallop3d && !isPencil3d) || !parallelHeightPartIdEff || heightRepairRequired) {
      const idleHandle = window.setTimeout(() => setParallel3dHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setParallel3dHeightPreview({ state: 'loading' })
      try {
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__parallel3d-smart-height-preview__',
            enabled: true,
            status: 'pending',
          }),
          name: opName.trim() || (isSteepShallow3d ? tx('NewOperationModalBody.Census_Steep_and_Shallow_preview') : isScallop3d ? tx('NewOperationModalBody.Census_Scallop_preview') : isPencil3d ? tx('NewOperationModalBody.Census_Pencil_preview') : tx('NewOperationModalBody.Census_3D_Finish_preview')),
          type: isSteepShallow3d ? 'steep_shallow_3d' : isScallop3d ? 'scallop_3d' : isPencil3d ? 'pencil_3d' : 'parallel_3d',
          toolId,
          geometrySelections: [parallelHeightPartIdEff],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withRestMachining(isSteepShallow3d ? steepShallow3d : isScallop3d ? scallop3d : isPencil3d ? pencil3d : parallel3d),
          smartHeight: {
            kind: 'smart_v2',
            intent: (isSteepShallow3d
              ? buildSteepShallow3dSmartIntent
              : isScallop3d ? buildScallop3dSmartIntent : isPencil3d ? buildPencil3dSmartIntent : buildParallel3dSmartIntent)({
                setupId: setup.id,
                geometryIds: [parallelHeightPartIdEff],
                safetyIntent: operationSafetyIntent,
                finishDepthMm: parallelHeightFinishDepth,
              }),
          },
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft).then(
          plan => { if (current) setParallel3dHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setParallel3dHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setParallel3dHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 250)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  }, [
    editingOperation, feedrateOverride, heights,
    heightRepairRequired, isParallel3d, isSteepShallow3d, isScallop3d, isPencil3d, linking, opName, parallel3d, parallel3dHeightAuthority,
    parallelHeightPartIdEff, parallelHeightFinishDepth, steepShallow3d, scallop3d, pencil3d,
    passes, previewOperationSmartHeightPlan, setup, toolId,
  ])

  // waterline_3d live Smart Height preview (WO-1176): the same debounce and
  // draft shape as the parallel effect above, under the waterline policy.
  const [waterline3dHeightPreview, setWaterline3dHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if (!isWaterline3d || !waterline3dPartIdEff || heightRepairRequired) {
      const idleHandle = window.setTimeout(() => setWaterline3dHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setWaterline3dHeightPreview({ state: 'loading' })
      try {
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__waterline3d-smart-height-preview__',
            enabled: true,
            status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Waterline_preview'),
          type: 'waterline_3d',
          toolId,
          geometrySelections: [waterline3dPartIdEff],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withFaceScope(waterline3d),
          smartHeight: {
            kind: 'smart_v2',
            intent: buildWaterline3dSmartIntent({
              setupId: setup.id,
              geometryIds: [waterline3dPartIdEff],
              safetyIntent: operationSafetyIntent,
              finishDepthMm: waterline3d.finishDepth,
            }),
          },
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft).then(
          plan => { if (current) setWaterline3dHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setWaterline3dHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setWaterline3dHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 250)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  }, [
    editingOperation, feedrateOverride, heights,
    heightRepairRequired, isWaterline3d, linking, opName, waterline3d,
    waterline3dPartIdEff, passes, previewOperationSmartHeightPlan, setup, toolId,
  ])
  // A fresh waterline starts at 10% of the chosen tool's diameter (floored at
  // 0.2 mm) until the operator types a stepdown of their own.
  const [waterlineStepdownTouched, setWaterlineStepdownTouched] = useState(false)
  useEffect(() => {
    if (!isWaterline3d || isEditMode || waterlineStepdownTouched || !selectedTool) return
    const next = defaultWaterlineStepdownFor(selectedTool.diameter)
    setWaterline3d(p => (p.stepdown === next ? p : { ...p, stepdown: next }))
  }, [isWaterline3d, isEditMode, waterlineStepdownTouched, selectedTool, setWaterline3d])

  const faceOwningStockId = setupProvenStockId(setup, project)
  const faceHasModelTop = !!faceOwningStockId && smartHeightModelTop(project, faceOwningStockId) !== null
  // WO-2273: a new untouched Face uses the existing starting recommendation.
  // Keep confirmation separate so later source evidence can refine that default;
  // authored choices and persisted/edit-mode authority never get replaced.
  const faceHeightChosen = faceHeightConfirmed || (!isEditMode && faceHeightAuthority === 'new' &&
    (faceHeightDraft.mode === 'target_face' ? !!face.targetPlaneGeo : !!faceOwningStockId))
  const faceTargetGeometryIds = face.targetPlaneGeo ? [face.targetPlaneGeo.geoId] : []
  const buildFaceSmartHeightAuthority = () => ({
    kind: 'smart_v2' as const,
    intent: buildFaceSmartHeightIntent({
      setupId: setup.id,
      safetyIntent: operationSafetyIntent,
      mode: faceHeightDraft.mode,
      geometryIds: faceHeightDraft.mode === 'target_face' ? faceTargetGeometryIds : undefined,
      stockId: faceHeightDraft.mode !== 'target_face' ? faceOwningStockId : undefined,
      explicitTargetWcsMm: faceHeightDraft.mode === 'explicit_depth'
        ? faceHeightDraft.explicitTargetWcsMm
        : undefined,
    }),
  })
  const [faceHeightPreview, setFaceHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if (!isFace || heightRepairRequired || !faceHeightChosen || !toolId) {
      const idleHandle = window.setTimeout(() => setFaceHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setFaceHeightPreview({ state: 'loading' })
      try {
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__face-smart-height-preview__', enabled: true, status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Face_preview'),
          type: 'face',
          toolId,
          geometrySelections: face.boundarySource !== 'stock' ? face.loopIds : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: face as unknown as Record<string, unknown>,
          smartHeight: buildFaceSmartHeightAuthority(),
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft).then(
          plan => { if (current) setFaceHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setFaceHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setFaceHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 250)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  }, [
    editingOperation, face, faceHeightChosen, faceHeightDraft, faceHeightAuthority,
    feedrateOverride, heightRepairRequired, heights, isFace, linking, opName, passes,
    previewOperationSmartHeightPlan, setup, toolId,
  ])
  // Every source-part viewport button routes through this single predicate.
  // WO-329: a loopless STL is now viewport-eligible for any chain-consuming
  // operation, matching the dropdown - picking it in the viewport derives its
  // chains the same way choosing it from the dropdown does (setGeoId), so the
  // dropdown is no longer the only reachable door for a fresh STL.
  const viewportPickSourceGeometries = project.geometry.filter((geometry) =>
    isViewportPickableOperationSource(geometry, opType),
  )

  // Total Z drop = chamferWidth + tipOffset. chamferWidth is the Z depth below the face.
  const chamferDepthMm = (() => {
    if (!isChamfer || !selectedTool?.angleFromAxisDeg) return null
    // angleFromAxisDeg is already the per-side half-angle; toolHalfAngleRad deg2rads it.
    // (zDrop below is angle-independent; this guard only rejects a degenerate angle.)
    const halfAngle = toolHalfAngleRad(selectedTool.angleFromAxisDeg)
    const tanHalf   = Math.tan(halfAngle)
    if (tanHalf < 1e-9) return null
    return chamfer.chamferWidth + chamfer.tipOffset
  })()

  // Resolved reference plane Z (WCS) — mirrors resolveChamferTopZ in store/index.ts
  const chamferResolvedTopZ = (() => {
    if (!isChamfer) return null
    const heightReference = chamfer.heightReference ?? 'absolute'
    const planeOffset     = chamfer.planeOffset     ?? 0
    if (heightReference === 'absolute') return planeOffset
    const wcsZ  = setup.wcs.origin.z
    const stocks = project.sceneStock.fixedStocks
    const { stockId } = setup.wcs
    const stock = stockId        ? stocks.find(s => s.id === stockId)
                : stocks.length === 1 ? stocks[0]
                : undefined
    if (heightReference === 'stock_top')    return (stock ? (stock.position.z + stock.depth) - wcsZ : 0) + planeOffset
    if (heightReference === 'stock_bottom') return (stock ? stock.position.z - wcsZ : 0) + planeOffset
    if (heightReference === 'model_top') {
      const geo = project.geometry.find(g => g.id === chamfer.geometryId)
      return (geo ? (geo.position.z + geo.boundingBox.max.z) - wcsZ : 0) + planeOffset
    }
    if (heightReference === 'geometry_face') {
      const geoFaceZ = (g: typeof project.geometry[0]) => {
        const layerZs = (g.layers2d ?? [])
          .map(l => l.projectionPlane?.origin.z)
          .filter((z): z is number => z !== undefined)
        if (layerZs.length > 0) return Math.max(...layerZs)
        if (g.projectionPlane) return g.projectionPlane.origin.z
        return g.position.z   // loop plane, NOT bbox top (B17, Operator 2026-06-13)
      }
      if (chamfer.geometryId === '__all__') {
        // INT-17A-R1 C2: the one '__all__' aggregation in this file that is NOT
        // loop-guarded - geoFaceZ falls back to `g.position.z` for a row with no
        // layers2d and no projectionPlane, which is exactly a modeled body, so a
        // body sitting high in Z would silently raise every All-Parts chamfer's
        // reference plane. Same shared refusal as the compute seam.
        const faces = resolveOpGeometrySources(project.geometry, '__all__').map(geoFaceZ)   // no wcsZ floor (B17)
        const faceWorldZ = faces.length ? Math.max(...faces) : wcsZ
        return (faceWorldZ - wcsZ) + planeOffset
      }
      const geo = project.geometry.find(g => g.id === chamfer.geometryId)
      const faceWorldZ = geo ? geoFaceZ(geo) : wcsZ
      return (faceWorldZ - wcsZ) + planeOffset
    }
    return 0 + planeOffset  // wcs_plane
  })()

  // Shared geometry id (declared early so the reference resolver below can use
  // it). '__all__' means collect from every loaded 2D file.
  const geoId = isFace ? face.geometryId : isDrill ? drill.geometryId : isBore ? bore.geometryId : isThreadMill ? threadMill.geometryId : isPocket ? pocket.geometryId : isChamfer ? chamfer.geometryId : isEngrave ? engrave.geometryId : isVCarve ? vcarve.geometryId : isAdaptive ? adaptive.geometryId : contour.geometryId

  // ── Bottom-of-cut reference plane selector (generalized from pocket) ─────────
  // Face/Engrave reference governs the TOP of cut (where the cut starts); every
  // other op governs the BOTTOM of cut. Chamfer keeps its own dedicated block
  // above; pocket keeps its own below. This covers contour / drill / face /
  // engrave / adaptive_clearing in the shared "else" branch.
  // Internal thread mills are TOP-governed (reference = thread top, runs down a
  // hole). EXTERNAL thread mills carry a reference-DIRECTION toggle: 'top' (the
  // default) is TOP-governed (reference = boss top, thread runs DOWN from it);
  // 'base' is BOTTOM-governed (reference = boss base, the thread climbs UP the
  // boss; top = base + depth). threadMill state is in scope here (declared near
  // the top of the component).
  const refGovernsTop = isFace || isEngrave || isVCarve || (isThreadMill && (threadMill.threadKind !== 'external' || (threadMill.externalReference ?? 'top') === 'top'))
  const refSupported  = isContour || isDrill || isBore || isThreadMill || isFace || isEngrave || isVCarve || isAdaptive
  const opHeightReference: ChamferHeightReference =
    (isContour    ? contour.heightReference    :
     isDrill      ? drill.heightReference      :
     isBore       ? bore.heightReference       :
     isThreadMill ? threadMill.heightReference :
     isFace       ? face.heightReference       :
     isEngrave    ? engrave.heightReference    :
     isVCarve     ? vcarve.heightReference     :
     isAdaptive   ? adaptive.heightReference   : undefined)
    ?? (refGovernsTop ? 'stock_top' : 'wcs_plane')
  const opPlaneOffset: number =
    (isContour    ? contour.planeOffset    :
     isDrill      ? drill.planeOffset      :
     isBore       ? bore.planeOffset       :
     isThreadMill ? threadMill.planeOffset :
     isFace       ? face.planeOffset       :
     isEngrave    ? engrave.planeOffset    :
     isVCarve     ? vcarve.planeOffset     :
     isAdaptive   ? adaptive.planeOffset   : undefined) ?? 0
  // Op-type + params the shared height-ref mapping needs (thread-mill direction
  // decides top- vs bottom-governed). Single-sourced with the PropertiesPanel via
  // src/lib/cam/heightReference.ts (UI-STANDARD 11.6).
  const modalOpType: HeightRefOpType =
    isContour ? 'contour_2d' : isDrill ? 'drill' : isBore ? 'bore' : isThreadMill ? 'thread_mill' :
    isFace ? 'face' : isEngrave ? 'engrave' : isVCarve ? 'vcarve' : isAdaptive ? 'adaptive_clearing_2d' :
    isPocket ? 'pocket_2d' : isChamfer ? 'chamfer' : 'contour_2d'
  const heightRefParams: HeightRefParams = {
    heightReference: opHeightReference,
    planeOffset: opPlaneOffset,
    threadKind: threadMill.threadKind,
    externalReference: threadMill.externalReference,
  }
  const editNumericHeight = (
    plane: HeightPlaneName,
    resolvedWcsZ: number,
    patch: Partial<HeightParams>,
  ) => {
    markUserSafetyOverride(plane)
    setHeights(current => {
      const next = { ...current, ...patch }
      return {
        ...next,
        heightIntent: heightIntentAfterNumericEdit(
          next,
          plane,
          resolvedWcsZ,
          reference => resolveIntentReferenceWcsZ(reference, next),
        ),
      }
    })
  }
  const setOpHeightReference = (ref: ChamferHeightReference) => {
    const { heights: hUpd } = deriveHeightRefUpdate(modalOpType, heights, heightRefParams, ref)
    if (isContour)          setContour(c     => ({ ...c, heightReference: ref }))
    else if (isDrill)       setDrill(d       => ({ ...d, heightReference: ref }))
    else if (isBore)        setBore(b        => ({ ...b, heightReference: ref }))
    else if (isThreadMill)  setThreadMill(t  => ({ ...t, heightReference: ref }))
    else if (isFace)        setFace(f        => ({ ...f, heightReference: ref }))
    else if (isEngrave)     setEngrave(e     => ({ ...e, heightReference: ref }))
    else if (isVCarve)      setVCarve(v      => ({ ...v, heightReference: ref }))
    else if (isAdaptive)    setAdaptive(a    => ({ ...a, heightReference: ref }))
    // This generalized selector governs the BOTTOM of cut only when the
    // reference does NOT govern the top (face/engrave/thread-top). Flag a manual
    // bottom override only in that case -> suppress recompute cylinder-floor heal.
    setHeights(h => ({ ...h, ...hUpd }))
  }
  const setOpPlaneOffset = (off: number, ref = opHeightReference) => {
    const hUpd = deriveHeightPlaneOffsetUpdate(modalOpType, heights, heightRefParams, ref, off)
    if (isContour)          setContour(c     => ({ ...c, planeOffset: off }))
    else if (isDrill)       setDrill(d       => ({ ...d, planeOffset: off }))
    else if (isBore)        setBore(b        => ({ ...b, planeOffset: off }))
    else if (isThreadMill)  setThreadMill(t  => ({ ...t, planeOffset: off }))
    else if (isFace)        setFace(f        => ({ ...f, planeOffset: off }))
    else if (isEngrave)     setEngrave(e     => ({ ...e, planeOffset: off }))
    else if (isVCarve)      setVCarve(v      => ({ ...v, planeOffset: off }))
    else if (isAdaptive)    setAdaptive(a    => ({ ...a, planeOffset: off }))
    // Bottom-of-cut offset edit (only when this selector governs the bottom).
    // An absolute Adaptive Clearing Z is the explicit Target End itself.
    setHeights(h => ({ ...h, ...hUpd, ...(isAdaptive && ref === 'absolute' ? { bottomHeight: off } : {}) }))
  }

  const setPocketReferenceAndIntent = (
    reference: ChamferHeightReference,
    offset: number,
    patch: Partial<typeof pocket> = {},
  ) => {
    setRowPlaneOverride('bottom', undefined)
    setPocket(current => ({
      ...current,
      ...patch,
      heightReference: reference,
      planeOffset: offset,
    }))
    setHeights(current => ({
      ...current,
      ...deriveHeightPlaneOffsetUpdate(
        'pocket_2d', current, { ...pocket, ...patch, heightReference: reference }, reference, offset,
      ),
    }))
  }

  const setAdaptiveReferenceAndIntent = (
    reference: ChamferHeightReference,
    offset: number,
    patch: Partial<typeof adaptive> = {},
  ) => {
    setRowPlaneOverride('bottom', undefined)
    setAdaptive(current => ({
      ...current,
      ...patch,
      heightReference: reference,
      planeOffset: offset,
    }))
    setHeights(current => ({
      ...current,
      ...deriveHeightPlaneOffsetUpdate(
        'adaptive_clearing_2d', current,
        { ...adaptive, ...patch, heightReference: reference }, reference, offset,
      ),
    }))
  }

  const clearSelectedBottom = () => setHeights(current => ({
    ...current,
    bottomHeightMode: 'absolute',
    selectedFaceZ: undefined,
    bottomManual: true,
    heightIntent: heightIntentAfterReferenceEdit(
      current, 'bottom', 'wcs_plane', current.bottomHeight,
    ),
  }))

  const setSelectedBottom = (
    selectedFaceZ: number,
    patch: Partial<HeightParams> = {},
  ) => setHeights(current => {
    const next = {
      ...current,
      ...patch,
      bottomHeightMode: 'selected_face' as const,
      selectedFaceZ,
      bottomHeight: selectedFaceZ - setup.wcs.origin.z,
    }
    return {
      ...next,
      heightIntent: heightIntentAfterReferenceEdit(
        next, 'bottom', 'selected_feature_bottom', 0,
      ),
    }
  })

  type EndCondition =
    | 'depth_from_top'
    | 'to_geometry'
    | 'to_stock_bottom'
    | 'through_stock'
    | 'stop_above_bottom'
    | 'selected_surface'
    | 'custom'
  const endConditionSupported = isPocket || isAdaptive
  const endReference = isPocket ? (pocket.heightReference ?? 'stock_top') : opHeightReference
  const endOffset = isPocket ? (pocket.planeOffset ?? 0) : opPlaneOffset
  const endCondition: EndCondition = customEndCondition ? 'custom'
    : heights.bottomHeightMode === 'selected_face' ? 'selected_surface'
    : endReference === 'geometry_face' && endOffset === 0 ? 'to_geometry'
    : endReference === 'stock_top' && endOffset < 0 ? 'depth_from_top'
    : endReference === 'stock_bottom' && endOffset < 0 ? 'through_stock'
    : endReference === 'stock_bottom' && endOffset > 0 ? 'stop_above_bottom'
    : endReference === 'stock_bottom' ? 'to_stock_bottom'
    : endReference === 'picked_plane' ? 'selected_surface'
    : 'custom'
  // WO-1599: End condition IS the bottom of cut; its reference + offset fields
  // appear only where no preset names the plane (Custom, or a picked surface
  // that needs its pick). A stock-boundary rough never reads this state - its
  // Smart plan owns the bottom and the Bottom Height row overrides it.
  const planarEndFieldsShown = !planarRoughUsesStockBoundary &&
    (endCondition === 'custom' || endCondition === 'selected_surface')
  const setEndReference = (reference: ChamferHeightReference, offset: number) => {
    setRowPlaneOverride('bottom', undefined)
    setPlanarStockSmartOptIn(false)
    setPlanarGeometrySmartOptIn(true)
    if (reference === 'stock_bottom' && offset < 0) {
      setPasses(current => ({ ...current, floorStockToLeave: 0 }))
    }
    if (isPocket) {
      setPocketReferenceAndIntent(reference, offset)
      return
    }
    setOpHeightReference(reference)
    setOpPlaneOffset(offset, reference)
  }
  const setEndCondition = (condition: EndCondition) => {
    setCustomEndCondition(condition === 'custom')
    switch (condition) {
      case 'depth_from_top': setEndReference('stock_top', -5); break
      case 'to_geometry': setEndReference('geometry_face', 0); break
      case 'to_stock_bottom': setEndReference('stock_bottom', 0); break
      case 'through_stock': setEndReference('stock_bottom', -0.5); break
      case 'stop_above_bottom': setEndReference('stock_bottom', 0.5); break
      case 'selected_surface': setEndReference('picked_plane', 0); break
      case 'custom': break
    }
  }

  // Live resolved WCS Z of a reference plane for the diagram preview. Phase 2:
  // this calls the SAME resolveTopZ the dispatch uses (threading project.stocks),
  // so the previewed plane and the computed toolpath cannot drift (B19b). The
  // dispatch remains the source of truth; this is informational. A frame that
  // cannot be resolved for the preview (e.g. an '__all__' selection spanning two
  // stocks) is caught and rendered as "no plane" rather than crashing the modal -
  // the real dispatch will surface the OwningStockError as the op error.
  // 'picked_plane' MANUAL datum accessor (defined here so the preview below can
  // thread it into resolveTopZ). Spans ALL ops that carry the field; the resolver
  // reads it ONLY when heightReference === 'picked_plane'. The matching setters +
  // pick handler are defined further down (after isAllGeo / selectedGeo).
  type ReferencePlaneGeo = { geoId: string; faceIndex: number; localZ: number }
  const opReferencePlaneGeo: ReferencePlaneGeo | undefined =
    isContour    ? contour.referencePlaneGeo    :
    isDrill      ? drill.referencePlaneGeo      :
    isBore       ? bore.referencePlaneGeo       :
    isThreadMill ? threadMill.referencePlaneGeo :
    isFace       ? face.referencePlaneGeo       :
    isEngrave    ? engrave.referencePlaneGeo    :
    isVCarve     ? vcarve.referencePlaneGeo     :
    isAdaptive   ? adaptive.referencePlaneGeo   :
    isPocket     ? pocket.referencePlaneGeo     :
    isChamfer    ? chamfer.referencePlaneGeo    : undefined

  const resolveRefZ = (
    ref: ChamferHeightReference,
    offset: number,
    gId: string,
    loopIds: ReadonlyArray<string> = [],
  ): number | undefined => {
    // Preview-only: a 'picked_plane' reference with nothing picked yet is a valid
    // in-progress UI state (the operator is about to click a face), NOT an error -
    // render "no plane" rather than letting the resolver's fail-loud throw crash
    // the whole modal. The real dispatch still fails loud at Create time.
    if (ref === 'picked_plane' && !opReferencePlaneGeo) return undefined
    try {
      return resolveTopZ(ref, offset, setup, project.sceneStock, project.geometry, gId, project.stocks, loopIds, opReferencePlaneGeo)
    } catch (err) {
      // CAM-BINDING Stage 1: a model-origin source is now a legal, selectable
      // pick (isModelOpSourceEligible) - so resolveTopZ's SAME compute-boundary
      // guard (computeGeometryScope) that used to only ever fire for a genuine
      // mistake now ALSO fires for an ordinary, in-progress Stage 1 selection,
      // every render, while the wizard is open. Render "no plane" here exactly
      // like the other two graceful cases - the real fail-loud outcome is
      // computeOperationToolpath's own guard at Create/Compute time, which
      // lands the op on the named 'unsupported' status, never a crash.
      if (err instanceof OwningStockError || err instanceof ReferencePlaneError
          || err instanceof ModelOriginComputeError) return undefined
      throw err
    }
  }

  // Resolved plane the diagram should draw for the reference-governed ops:
  // face/engrave move the TOP; contour/drill/AC move the BOTTOM. Non-absolute
  // references (and absolute, whose value lives in planeOffset for these ops)
  // are reflected so the diagram tracks the real cut plane (prompt: "reflect the
  // resolved bottom value as it does now").
  // The op's LIVE loop selection, so the preview narrows the '__all__' aggregate
  // to the owning geometry exactly as the dispatch does (ADR-0020 rule 2). Same
  // expression as selectedLoopIds below; computed here for the resolveRefZ call.
  const refSelectedLoopIds = isFace ? face.loopIds : isDrill ? drill.loopIds : isBore ? bore.loopIds : isThreadMill ? threadMill.loopIds : isPocket ? pocket.loopIds : isChamfer ? chamfer.loopIds : isEngrave ? engrave.loopIds : isVCarve ? vcarve.loopIds : isAdaptive ? adaptive.loopIds : contour.loopIds
  const refResolvedZ = refSupported ? resolveRefZ(opHeightReference, opPlaneOffset, geoId, refSelectedLoopIds) : undefined

  // Shared geometry — '__all__' means collect from every loaded 2D file
  const isAllGeo    = geoId === '__all__'
  const selectedGeo = isAllGeo ? null : project.geometry.find(g => g.id === geoId)
  // Display lookups retain the durable reference's actual owner, including
  // legacy ownership. Neither a missing body nor another selection is its name.
  const geometryNameForId = (id: string) => {
    const geo = project.geometry.find(candidate => candidate.id === id)
    return geo ? geometryDisplayName(geo, project.modelItems) : tx('NewOperationModalBody.Reference_unavailable')
  }
  const machiningBoundaryGeo = machiningBoundaryFace ? project.geometry.find(candidate =>
    candidate.modelBody?.ref.bodyId === machiningBoundaryFace.bodyId &&
    resolveOwningModelItemId(candidate) === (machiningBoundaryFace.modelItemId ?? LEGACY_MODEL_ITEM_ID)) : undefined
  const allGeoSources = resolveOpGeometrySources(project.geometry, '__all__', opType)
  // Engrave/Trace can follow either kind. Contour deliberately exposes exactly
  // one path family at a time; every other 2D/2.5D op remains closed-only.
  const loopIsPickable = (l: { closed: boolean }) =>
    isEngrave ? true
    : isContour ? (contourPathType === 'open' ? !l.closed : l.closed)
    : l.closed
  // WO-2859: under All Parts each row is one loop ON one part - two copies of
  // one STL list the same chain id once per copy, and a tick names the copy.
  const closedLoopRows = isAllGeo
    ? allGeoSources.flatMap(g => (g.loops ?? []).filter(loopIsPickable).map(loop => ({ loop, source: g })))
    : selectedGeo
      ? (geometryForOperation(selectedGeo, opType).loops ?? []).filter(loopIsPickable).map(loop => ({ loop, source: selectedGeo }))
      : []
  const closedLoops = closedLoopRows.map(row => row.loop)
  const selectedLoopIds = isFace ? face.loopIds : isDrill ? drill.loopIds : isBore ? bore.loopIds : isThreadMill ? threadMill.loopIds : isPocket ? pocket.loopIds : isChamfer ? chamfer.loopIds : isEngrave ? engrave.loopIds : isVCarve ? vcarve.loopIds : isAdaptive ? adaptive.loopIds : contour.loopIds
  // WO-2859: an STL's hole detection resolves later; it may only fill in the
  // source, family and still-empty pick it started from, never one the
  // operator has moved on to in the meantime.
  const holeDetectTargetRef = useRef({ geoId, opType, picked: selectedLoopIds.length })
  holeDetectTargetRef.current = { geoId, opType, picked: selectedLoopIds.length }

  // WO-1942: Thread Mill authors its band from the same picked-cylinder stand-in.
  // A pick belongs to the family that made it (a Thread Mill pick lands on an
  // mthread: loop), so switching Bore <-> Thread Mill never carries it across.
  const modelBoreBindingForOp = modelBoreBinding && (!modelBoreBinding.derived ||
      modelBoreBinding.derived.loop.id.startsWith('mthread:') === isThreadMill)
    ? modelBoreBinding
    : null
  const modelBoreAuthoringGeometry = (isBore || isThreadMill) && selectedGeo && modelBoreBindingForOp?.derived &&
      modelReferenceMatchesSource(modelBoreBindingForOp, {
        modelItemId: resolveOwningModelItemId(selectedGeo),
        bodyId: selectedGeo.modelBody?.ref.bodyId,
      })
    ? {
        ...selectedGeo,
        loops: [
          ...(selectedGeo.loops ?? []).filter(loop => loop.id !== modelBoreBindingForOp.derived!.loop.id),
          modelBoreBindingForOp.derived.loop,
        ],
        layers2d: [
          ...(selectedGeo.layers2d ?? []).filter(layer => layer.id !== modelBoreBindingForOp.derived!.loop.layerId),
          {
            id: modelBoreBindingForOp.derived.loop.layerId,
            name: isThreadMill ? tx('NewOperationModalBody.Census_Selected_model_cylinder') : tx('NewOperationModalBody.Census_Selected_model_bore'),
            color: '#4ea1ff',
            visible: true,
            derived: true,
            frame: 'geometry_local' as const,
            cylinders: [modelBoreBindingForOp.derived.cylinder],
          },
        ],
      }
    : undefined
  const drillBoreSourceGeometries = (isDrill || isBore)
    ? (modelBoreAuthoringGeometry
        ? [modelBoreAuthoringGeometry]
        : geoId === '__all__'
          ? resolveOpGeometrySources(project.geometry, '__all__', opType)
          : project.geometry.filter(candidate => candidate.id === geoId))
    : []
  const effectiveDrillBoreLoopIds = (isDrill || isBore)
    ? (selectedLoopIds.length > 0 ? [...selectedLoopIds] : closedLoops.map(loop => loop.id))
    : []
  const drillBoreSelectionAvailable = effectiveDrillBoreLoopIds.every(loopId =>
    drillBoreSourceGeometries.some(geometry => (geometry.loops ?? []).some(loop => loop.id === loopId)),
  )
  const persistedDrillBoreV2 = (() => {
    if (!editingOperation?.smartHeight) return undefined
    const validated = validatePersistedSmartHeightState(editingOperation.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') return undefined
    if (validated.state.intent.policy.operationType !== (isDrill ? 'drill' : 'bore')) return undefined
    return validated.state
  })()
  const preservesUnmaterializedModelFeature =
    drillBoreHeightAuthority === 'smart_v2' &&
    drillBoreHeightDraft.mode === 'detected_features' &&
    !drillBoreSelectionAvailable &&
    persistedDrillBoreV2?.intent.policy.variant === 'detected_features'
  const drillBoreHeightAuthorityForDraft = (): Operation['smartHeight'] => ({
    kind: 'smart_v2',
    intent: buildDrillBoreAuthoringIntent({
      operationType: isDrill ? 'drill' : 'bore',
      setupId: setup.id,
      safetyIntent: operationSafetyIntent,
      geometries: drillBoreSourceGeometries,
      selectedLoopIds: effectiveDrillBoreLoopIds,
      draft: drillBoreHeightDraft,
      perFeatureEndOverridesWcsMm: isDrill
        ? drill.perHoleDepthOverrides
        : bore.perBoreDepthOverrides,
    }),
  })
  const drillBoreSmartHeightForSave = (): Operation['smartHeight'] => {
    if (preservesUnmaterializedModelFeature) return persistedDrillBoreV2
    if (!heightRepairRequired) return drillBoreHeightAuthorityForDraft()
    throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE)
  }
  const drillParamsForSave = (): typeof drill => ({
    ...drill,
    loopIds: [...effectiveDrillBoreLoopIds],
    perHoleDepth: drillBoreHeightDraft.mode === 'detected_features',
  })
  const boreParamsForSave = (): typeof bore => ({
    ...bore,
    loopIds: [...effectiveDrillBoreLoopIds],
    perBoreDepth: drillBoreHeightDraft.mode === 'detected_features',
  })

  const contourHeightAuthorityForDraft = (): Operation['smartHeight'] => {
    const sourceGeometries = geoId === '__all__'
      ? resolveOpGeometrySources(project.geometry, '__all__', 'contour_2d')
      : project.geometry.filter(candidate => candidate.id === geoId)
    const selectedIds = contour.loopIds
    const geometryIds = sourceGeometries
      .filter(geometry => (geometry.loops ?? []).some(loop => selectedIds.includes(loop.id)))
      .map(geometry => geometry.id)
    if (geometryIds.length === 0 && sourceGeometries.length === 1) {
      geometryIds.push(sourceGeometries[0].id)
    }
    if (geometryIds.length === 0) {
      throw new Error(tx('NewOperationModalBody.Contour_Smart_Height_requires_selected_machining_geometry'))
    }
    let features
    if (contourHeightDraft.mode === 'selected_feature') {
      const derived = deriveContourFeatureBindings(sourceGeometries, selectedIds)
      if (!derived.ok) {
        throw new Error(derived.refusals.map(refusal => refusal.message).join(' '))
      }
      features = derived.bindings.map(binding => binding.feature)
    }
    return {
      kind: 'smart_v2',
      intent: buildContourSmartHeightIntent({
        setupId: setup.id,
        safetyIntent: operationSafetyIntent,
        mode: contourHeightDraft.mode,
        geometryIds: contourHeightDraft.mode === 'selected_feature' ? undefined : geometryIds,
        features,
        explicitTargetWcsMm: contourHeightDraft.mode === 'explicit_depth'
          ? contourHeightDraft.explicitTargetWcsMm
          : undefined,
        throughAllowanceMm: contourHeightDraft.mode === 'through_stock'
          ? contourHeightDraft.throughAllowanceMm
          : undefined,
      }),
    }
  }
  const contourSmartHeightForSave = (): Operation['smartHeight'] => {
    if (!heightRepairRequired) return contourHeightAuthorityForDraft()
    throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE)
  }
  const [contourHeightPreview, setContourHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  const contourHasSetupStock = Boolean(setupProvenStockId(setup, project))
  useEffect(() => {
    // A modeled-body source IS the machining target: it has no top-level loops
    // to pick (the store derives its profile, or the bound edge chain, at
    // compute), and finishModelEdgePick clears loopIds on purpose. Without this
    // a contour from a modeled body never leaves 'idle' and Create stays
    // disabled for good. Curve sources still need at least one selected loop.
    const hasContourTarget = contour.loopIds.length > 0
      || modelEdgeChain !== null
      || selectedGeo?.type === 'model'
    if (!isContour || heightRepairRequired || !hasContourTarget) {
      const idleHandle = window.setTimeout(() => setContourHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    // WO-1610: every Contour end (stock bottom, feature floor, an explicit Z)
    // starts cutting at the stock top, so without a stock there is nothing to
    // resolve. Say that in one sentence instead of the store's internal refusal.
    if (!contourHasSetupStock) {
      const noStockHandle = window.setTimeout(() => setContourHeightPreview({
        state: 'error', message: contourNeedsStockMessage(),
      }), 0)
      return () => window.clearTimeout(noStockHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setContourHeightPreview({ state: 'loading' })
      try {
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__contour-smart-height-preview__', enabled: true, status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Contour_Smart_Height_preview'),
          type: 'contour_2d',
          toolId,
          geometrySelections: [...contour.loopIds],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: contour as unknown as Record<string, unknown>,
          smartHeight: contourHeightAuthorityForDraft(),
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft).then(
          plan => { if (current) setContourHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setContourHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setContourHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 200)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  // The draft authority is intentionally rebuilt from these exact UI and project inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    contour, contourHeightAuthority, contourHeightDraft, editingOperation, feedrateOverride,
    heights, isContour, linking, modelEdgeChain, opName, passes, previewOperationSmartHeightPlan,
    contourHasSetupStock, project.geometry, selectedGeo, setup, toolId,
  ])

  // A flat imported curve cannot supply the default detected feature floor.
  // Expose the operation's actionable Target End policy beside the refusal;
  // otherwise both are hidden behind the collapsed Bottom Height summary row.
  useEffect(() => {
    if (isContour && contourHeightPreview.state === 'error') {
      setExpandedHeightPlane('bottom')
    }
  }, [isContour, contourHeightPreview.state])

  const [drillBoreHeightPreview, setDrillBoreHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if (preservesUnmaterializedModelFeature && editingOperation?.resolvedHeightPlan) {
      const resolvedHandle = window.setTimeout(() => setDrillBoreHeightPreview({
        state: 'resolved',
        plan: editingOperation.resolvedHeightPlan!,
      }), 0)
      return () => window.clearTimeout(resolvedHandle)
    }
    if ((!isDrill && !isBore) || heightRepairRequired ||
        effectiveDrillBoreLoopIds.length === 0) {
      const idleHandle = window.setTimeout(() => setDrillBoreHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setDrillBoreHeightPreview({ state: 'loading' })
      try {
        const params = isDrill ? drillParamsForSave() : boreParamsForSave()
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__drill-bore-smart-height-preview__', enabled: true, status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Smart_Height_preview', { p1: isDrill ? tx('NewOperationModalBody.Drill') : tx('NewOperationModalBody.Bore') }),
          type: isDrill ? 'drill' : 'bore',
          toolId,
          geometrySelections: [...effectiveDrillBoreLoopIds],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: params as unknown as Record<string, unknown>,
          smartHeight: drillBoreHeightAuthorityForDraft(),
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft, drillBoreSourceGeometries).then(
          plan => { if (current) setDrillBoreHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setDrillBoreHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setDrillBoreHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 200)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  // The draft authority is rebuilt from these exact UI and project inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bore, drill, drillBoreHeightAuthority, drillBoreHeightDraft, editingOperation,
    feedrateOverride, heights, isBore, isDrill, linking, opName, passes,
    previewOperationSmartHeightPlan, project.geometry, setup, toolId,
    preservesUnmaterializedModelFeature,
  ])

  const threadMillSourceGeometries = isThreadMill
    ? (modelBoreAuthoringGeometry
        ? [modelBoreAuthoringGeometry]
        : geoId === '__all__'
        ? resolveOpGeometrySources(project.geometry, '__all__', 'thread_mill')
        : project.geometry.filter(candidate => candidate.id === geoId))
    : []
  // WO-1942: editing a Thread Mill bound to a picked model cylinder re-reads
  // that face, so its band re-authors against the live cylinder instead of
  // refusing a loop that only exists at compute time.
  useEffect(() => {
    if (!isThreadMill || !modelBoreBinding || modelBoreBinding.derived) return
    const geo = project.geometry.find(candidate => candidate.id === threadMill.geometryId)
    if (!geo || geo.type !== 'model') return
    const { bodyId, faceStableId } = modelBoreBinding
    const modelItemId = modelBoreBinding.modelItemId ?? LEGACY_MODEL_ITEM_ID
    let current = true
    void ensureDocumentArchiveHydrated(
      project.id, modelItemId, project.modelItems?.find(m => m.id === modelItemId),
    ).then(() => readModelBodyFaceFacts(bodyId, faceStableId, modelItemId)).then(({ snapshot, verdicts }) => {
      if (!current) return
      const target = deriveModelThreadMillTarget(
        geo, project.modelItemPlacements ?? [], faceStableId, snapshot, verdicts,
      )
      setModelBoreBinding(prev => prev && prev.faceStableId === faceStableId && prev.bodyId === bodyId
        ? { ...prev, derived: { loop: target.loop, cylinder: target.cylinder } }
        : prev)
    }).catch((err: unknown) => {
      if (current) setBrepDeriveError(err instanceof Error ? err.message : String(err))
    })
    return () => { current = false }
  // Re-read only when the binding or its source changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isThreadMill, modelBoreBinding, threadMill.geometryId])

  const effectiveThreadMillLoopIds = isThreadMill
    ? (threadMill.loopIds.length > 0 ? [...threadMill.loopIds] : closedLoops.map(loop => loop.id))
    : []
  const [threadMillRepairConfirmed, setThreadMillRepairConfirmed] = useState(false)
  const threadMillHeightAuthority: 'smart_v2' | 'repair_required' =
    !heightRepairRequired || threadMillRepairConfirmed ? 'smart_v2' : 'repair_required'
  const threadMillHeightAuthorityForDraft = (): Operation['smartHeight'] => {
    const detected = threadMill.geometrySource === 'cylinder'
    let features
    let geometryIds: string[] | undefined
    if (detected) {
      const derived = deriveThreadMillFeatureBindings(
        threadMillSourceGeometries,
        effectiveThreadMillLoopIds,
      )
      if (!derived.ok) {
        throw new Error(derived.refusals.map(refusal => refusal.message).join(' '))
      }
      features = derived.bindings.map(binding => ({
        loopId: binding.loopId,
        featureKind: binding.featureKind,
        feature: { ...binding.feature },
        // Physical values are validated during authoring. Runtime rebinds the
        // stable feature and performs the model-aware frame conversion again.
        topMachineMm: binding.topMm,
        floorMachineMm: binding.floorMm,
        fingerprint: binding.evidenceFingerprint,
      }))
    } else {
      geometryIds = threadMillSourceGeometries
        .filter(geometry => (geometry.loops ?? []).some(loop =>
          effectiveThreadMillLoopIds.includes(loop.id)))
        .map(geometry => geometry.id)
      if (geometryIds.length === 0 && threadMillSourceGeometries.length === 1) {
        geometryIds.push(threadMillSourceGeometries[0].id)
      }
      if (geometryIds.length === 0) {
        throw new Error(tx('NewOperationModalBody.Thread_Mill_Smart_Height_requires_selected_machining_geometry'))
      }
    }
    const datumPlane: HeightPlaneName =
      threadMill.threadKind === 'external' && (threadMill.externalReference ?? 'top') === 'base'
        ? 'bottom'
        : 'top'
    return {
      kind: 'smart_v2',
      intent: buildThreadMillSmartHeightIntent({
        setupId: setup.id,
        safetyIntent: operationSafetyIntent,
        source: detected ? 'detected_feature' : 'explicit_band',
        threadKind: threadMill.threadKind,
        externalReference: threadMill.externalReference,
        threadDepthMm: threadMill.threadDepth ?? 0,
        planeOffsetMm: threadMill.planeOffset ?? 0,
        datumReference: detected
          ? undefined
          : intentReferenceForUiReference(
              threadMill.heightReference ?? 'geometry_face',
              datumPlane,
            ) as Exclude<HeightReference, HeightPlaneName>,
        features,
        geometryIds,
      }),
    }
  }
  const threadMillSmartHeightForSave = (): Operation['smartHeight'] =>
    threadMillHeightAuthority === 'smart_v2'
      ? threadMillHeightAuthorityForDraft()
      : (() => { throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE) })()
  const threadMillParamsForSave = (): ThreadMillParams =>
    threadMillHeightAuthority === 'smart_v2'
      ? { ...threadMill, loopIds: [...effectiveThreadMillLoopIds] }
      : threadMill
  const [threadMillHeightPreview, setThreadMillHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if (!isThreadMill || threadMillHeightAuthority === 'repair_required' ||
        effectiveThreadMillLoopIds.length === 0 || !toolId) {
      const idleHandle = window.setTimeout(() => setThreadMillHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setThreadMillHeightPreview({ state: 'loading' })
      try {
        const params = threadMillParamsForSave()
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__thread-mill-smart-height-preview__', enabled: true, status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Thread_Mill_Smart_Height_preview'),
          type: 'thread_mill',
          toolId,
          geometrySelections: [...params.loopIds],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: params as unknown as Record<string, unknown>,
          smartHeight: threadMillHeightAuthorityForDraft(),
        } as Operation
        void previewOperationSmartHeightPlan(
          setup.id,
          draft,
          threadMillSourceGeometries,
        ).then(
          plan => { if (current) setThreadMillHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setThreadMillHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setThreadMillHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 200)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  // The draft authority is rebuilt from these exact UI and project inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editingOperation, feedrateOverride, heights, isThreadMill, linking, opName, passes,
    previewOperationSmartHeightPlan, project.geometry, setup, threadMill, toolId,
  ])

  // WO-1941: an edge chain picked on the modeled body is the loop this Chamfer
  // bevels. Derived exactly as store compute derives it (closed chains only), so
  // the saved loop ids and Smart Height scope match what compute will see.
  const chamferModelChainGeometry = useMemo(() => {
    if (!isChamfer || !modelEdgeChain || geoId === '__all__') return null
    const chainGeo = project.geometry.find(g => g.id === geoId)
    if (chainGeo?.type !== 'model') return null
    const source = { modelItemId: chainGeo.modelItemId, bodyId: chainGeo.modelBody?.ref.bodyId }
    if (modelEdgeChainBodyMismatch(modelEdgeChain, source)) return null
    try {
      const derived = deriveModelBodyEdges(
        chainGeo, modelEdgeChain.edgeStableIds, project.modelItemPlacements ?? [],
        modelEdgeChainDeriveOptions('chamfer'),
      )
      return modelEdgeChainSourceGeometry('chamfer', chainGeo, derived.loops)
    } catch {
      // finishModelEdgePick already showed the named refusal for this pick.
      return null
    }
  }, [isChamfer, modelEdgeChain, geoId, project.geometry, project.modelItemPlacements])
  // The chain the preview draft carries, so the preview resolves the datum from
  // the picked edges exactly as store compute will (resolveChamferSmartRuntime).
  const chamferPreviewModelReferences: Operation['modelReferences'] =
    chamferModelChainGeometry && modelEdgeChain
      ? [{
          bodyId: modelEdgeChain.bodyId,
          ...(modelEdgeChain.modelItemId !== undefined ? { modelItemId: modelEdgeChain.modelItemId } : {}),
          stableIds: [...modelEdgeChain.edgeStableIds],
          role: 'edge-chain' as const,
        }]
      : undefined
  const chamferSourceGeometries = isChamfer
    ? (chamferModelChainGeometry
        ? [chamferModelChainGeometry]
        : geoId === '__all__'
        ? resolveOpGeometrySources(project.geometry, '__all__', 'chamfer')
        : project.geometry.filter(candidate => candidate.id === geoId))
    : []
  const effectiveChamferLoopIds = isChamfer
    ? (chamferModelChainGeometry
        ? (chamferModelChainGeometry.loops ?? []).filter(loop => loop.closed).map(loop => loop.id)
        : chamfer.loopIds.length > 0 ? [...chamfer.loopIds] : closedLoops.map(loop => loop.id))
    : []
  const [chamferRepairConfirmed, setChamferRepairConfirmed] = useState(false)
  const chamferHeightAuthority: 'smart_v2' | 'repair_required' =
    !heightRepairRequired || chamferRepairConfirmed ? 'smart_v2' : 'repair_required'
  // WO-3021: a modeled-chamfer sibling pass passes its own params and loops.
  const chamferHeightAuthorityForDraft = (
    params: typeof chamfer = chamfer,
    loopIds: readonly string[] = effectiveChamferLoopIds,
  ): Operation['smartHeight'] => {
    const derived = deriveChamferEdgeBindings(chamferSourceGeometries, [...loopIds])
    if (!derived.ok) throw new Error(derived.refusals.map(refusal => refusal.message).join(' '))
    return {
      kind: 'smart_v2',
      intent: buildChamferSmartHeightIntent({
        setupId: setup.id,
        safetyIntent: operationSafetyIntent,
        datumReference: intentReferenceForUiReference(
          params.heightReference ?? 'geometry_face',
          'top',
        ) as Exclude<HeightReference, HeightPlaneName>,
        datumOffsetMm: params.planeOffset ?? 0,
        chamferWidthMm: params.chamferWidth,
        tipOffsetMm: params.tipOffset,
        features: derived.bindings.map(binding => ({
          loopId: binding.loopId,
          feature: { ...binding.feature },
          fingerprint: binding.evidenceFingerprint,
        })),
      }),
    }
  }
  const chamferSmartHeightForSave = (): Operation['smartHeight'] =>
    chamferHeightAuthority === 'smart_v2'
      ? chamferHeightAuthorityForDraft()
      : (() => { throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE) })()
  const chamferParamsForSave = (): typeof chamfer =>
    chamferHeightAuthority === 'smart_v2'
      ? withoutStaleModeledChamfer({ ...chamfer, loopIds: [...effectiveChamferLoopIds] })
      : withoutStaleModeledChamfer(chamfer)

  // WO-3021: chamfers the part already has. The scan reads the part's own mesh
  // (STL bytes, a modeled body's tessellation, or the STEP tessellation the 3D
  // operations cut) and lists each proved chamfer as a pass over the part's
  // own loops, with the modeled depth and top-edge height.
  // A picked native edge chain does not hide it: filling from the model
  // replaces the chain with the chamfer's own loops (WO-3021 audit finding 2).
  const modeledChamferGeo = isChamfer && geoId && geoId !== '__all__'
    ? project.geometry.find(g => g.id === geoId)
    : undefined
  const modeledChamferReadable = !!modeledChamferGeo &&
    ((modeledChamferGeo.type === 'mesh' && modeledChamferGeo.format === 'stl') ||
      modeledChamferGeo.format === 'model' || modeledChamferGeo.format === 'step')
  const modeledChamferLoaders = (): ModeledChamferLoaders => ({
    loadStl: loadCachedSTL,
    loadStep: loadCachedStep,
    readStepChamfers: async (bytes) => {
      // The model kernel, in its own worker for this one reading.
      const { createGeomService } = await import('../../geom')
      const kernel = createGeomService()
      try {
        await kernel.init()
        const [body] = (await kernel.importStep(bytes, 'CHAMFER')).bodies
        if (!body) return { tessellation: { position: [], index: [], triFace: [], faceIds: [] }, verdicts: [] }
        const verdicts = await kernel.recognizeFeatures(body.handle)
        const tess = await kernel.tessellate(body.handle, { deflection: MODELED_CHAMFER_STEP_CHORD_MM, angularDeflection: 0.1 })
        return { tessellation: { position: tess.position, index: tess.index, triFace: tess.triFace, faceIds: tess.faceIds }, verdicts }
      } finally {
        await kernel.terminate().catch(() => undefined)
      }
    },
    placements: project.modelItemPlacements ?? [],
    frames: CHAMFER_FRAMES,
  })
  const [modeledChamferScan, setModeledChamferScan] = useState<
    { geoId: string; state: 'loading' } |
    { geoId: string; state: 'ready'; result: ModeledChamfersOnPart | null } |
    { geoId: string; state: 'error'; message: string } | null>(null)
  useEffect(() => {
    if (!modeledChamferReadable || !modeledChamferGeo) {
      const idle = window.setTimeout(() => setModeledChamferScan(null), 0)
      return () => window.clearTimeout(idle)
    }
    let current = true
    const geoForScan = modeledChamferGeo
    const handle = window.setTimeout(() => {
      setModeledChamferScan({ geoId: geoForScan.id, state: 'loading' })
      modeledChamfersOnPart(geoForScan, modeledChamferLoaders()).then(
        result => { if (current) setModeledChamferScan({ geoId: geoForScan.id, state: 'ready', result }) },
        (err: unknown) => {
          if (current) setModeledChamferScan({ geoId: geoForScan.id, state: 'error', message: err instanceof Error ? err.message : String(err) })
        },
      )
    }, 0)
    return () => { current = false; window.clearTimeout(handle) }
  // The loaders read the same project placements this list names.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeledChamferReadable, modeledChamferGeo, project.modelItemPlacements])
  const modeledChamferResult = modeledChamferScan?.state === 'ready' && modeledChamferScan.geoId === geoId
    ? modeledChamferScan.result
    : null
  /** The record the op carries, only while the op still has what it filled in
   *  (same part, loops, width and datum); a hand edit of those retires it. */
  const modeledChamferRecord = modeledChamferRecordOf(chamfer as unknown as Record<string, unknown>)
  function withoutStaleModeledChamfer(params: typeof chamfer): typeof chamfer {
    const carried = params as typeof params & { modeledChamfer?: unknown }
    if (carried.modeledChamfer === undefined || modeledChamferRecordOf(params as unknown as Record<string, unknown>)) return params
    const { modeledChamfer: _stale, ...rest } = carried
    // A stretch stays with its loop while the loop is selected (it is the
    // path the chamfer runs along); a loop taken out takes its stretch along.
    const extents = rest.loopExtents
    if (!extents) return rest
    const kept = Object.fromEntries(Object.entries(extents).filter(([id]) => rest.loopIds.includes(id)))
    const { loopExtents: _all, ...plain } = rest
    return Object.keys(kept).length > 0 ? { ...plain, loopExtents: kept } : plain
  }
  // "All modeled chamfers" with more than one top height, depth or angle: this
  // operation takes the first pass and Create adds the rest as their own
  // Chamfer operations (one chamfer2d pass has one reference plane).
  const [modeledChamferExtraPasses, setModeledChamferExtraPasses] = useState<{ geoId: string; passes: ChamferFromModelPass[] }>({ geoId: '', passes: [] })
  const extraModeledPasses = modeledChamferExtraPasses.geoId === chamfer.geometryId ? modeledChamferExtraPasses.passes : []
  const modeledPassDatum = (pass: ChamferFromModelPass) => modeledPassDatumIn(pass, {
    setup, geometry: project.geometry, sceneStock: project.sceneStock,
    stocks: project.stocks ?? [], placements: project.modelItemPlacements ?? [], frames: CHAMFER_FRAMES,
  })
  const applyModeledChamferPasses = (passes: readonly ChamferFromModelPass[]) => {
    const [first, ...rest] = passes
    if (!first) return
    // The modeled chamfer's own loops replace a picked native edge chain.
    if (modelEdgeChain) setModelEdgeChain(null)
    const filled = chamferParamsFromPass(chamfer, first.record.geometryId, first, modeledPassDatum(first))
    setChamfer(filled)
    setModeledChamferExtraPasses({ geoId: first.record.geometryId, passes: rest })
    setUserClearedLoops(false)
    pushPickedLoopsToViewport(filled.loopIds)
  }
  // A freshly modeled body has no loops yet: its chamfers get theirs from the
  // part's own Section at Z just under each lower edge (the same derived
  // layer Section at Z lands), then fill as any other part's do.
  const [modeledChamferDeriving, setModeledChamferDeriving] = useState<{ state: 'running' } | { state: 'error'; message: string } | null>(null)
  const fillModeledChamfers = async (
    result: ModeledChamfersOnPart,
    pick?: { rows?: readonly ModeledChamferLoop[]; featureId?: string },
  ) => {
    const pending = pick?.featureId
      ? result.pending.filter(p => p.featureId === pick.featureId)
      : pick?.rows ? [] : result.pending
    let scanned = result
    if (pending.length > 0 && geoId) {
      setModeledChamferDeriving({ state: 'running' })
      try {
        // A section already landed at that Z is not cut again.
        const landedZ = new Set((project.geometry.find(g => g.id === geoId)?.layers2d ?? [])
          .filter(layer => layer.derived && layer.projectionPlane).map(layer => layer.projectionPlane!.origin.z))
        for (const z of [...new Set(pending.map(p => p.sectionZ))]) if (!landedZ.has(z)) await deriveBrepLayer(geoId, 'section', { z })
        const fresh = useCamStore.getState().project.geometry.find(g => g.id === geoId)
        const rescanned = fresh ? await modeledChamfersOnPart(fresh as ChamferSourceGeometry, modeledChamferLoaders()) : null
        if (rescanned) {
          scanned = rescanned
          setModeledChamferScan({ geoId, state: 'ready', result: rescanned })
        }
        const stillPending = scanned.pending.filter(p => pending.some(q => q.featureId === p.featureId))
        setModeledChamferDeriving(stillPending.length > 0
          ? { state: 'error', message: tx('NewOperationModalBody.Modeled_chamfers_section_no_loop') }
          : null)
      } catch (err) {
        setModeledChamferDeriving({ state: 'error', message: err instanceof Error ? err.message : String(err) })
        return
      }
    }
    const rows = pick?.featureId
      ? scanned.loops.filter(row => row.featureIds.includes(pick.featureId!))
      : pick?.rows ?? scanned.loops
    if (rows.length === 0) return
    applyModeledChamferPasses(chamferPassesFromModel(rows, geoId, scanned.source))
  }
  // "Pick modeled chamfer": a click on a part edge in the 3D view takes the
  // modeled chamfer that runs along it (the same viewport loop pick the loop
  // list uses); an edge with no modeled chamfer leaves the op as it was.
  const [modeledChamferPicking, setModeledChamferPicking] = useState(false)
  const [modeledChamferPickMissed, setModeledChamferPickMissed] = useState(false)
  // A loop pick names a loop, not an edge: a loop carrying several separate
  // modeled chamfers is left as it was, and its rows' own Pick chooses one.
  const [modeledChamferPickSeveral, setModeledChamferPickSeveral] = useState(0)
  const chamferRef = useRef(chamfer)
  chamferRef.current = chamfer
  const modeledChamferPickingRef = useRef(false)
  modeledChamferPickingRef.current = modeledChamferPicking
  // The loop list's own pick takes the viewport over; closing the dialog ends it.
  useEffect(() => { if (isPickingLoops) setModeledChamferPicking(false) }, [isPickingLoops])
  useEffect(() => () => { if (modeledChamferPickingRef.current) getVp()?.setLoopPickMode?.(null) }, [])
  const stopModeledChamferPick = () => {
    setModeledChamferPicking(false)
    getVp()?.setLoopPickMode?.(null)
    getVp()?.setPickedLoops?.(chamfer.loopIds)
  }
  const startModeledChamferPick = (result: ModeledChamfersOnPart) => {
    if (isPickingLoops) stopLoopPicking()
    setModeledChamferPicking(true)
    setModeledChamferPickMissed(false)
    setModeledChamferPickSeveral(0)
    getVp()?.setPickedLoops?.(chamfer.loopIds)
    getVp()?.setLoopPickMode?.((loopId) => {
      const found = result.loops.filter(loop => loop.loopId === loopId)
      if (found.length !== 1) {
        setModeledChamferPickMissed(found.length === 0)
        setModeledChamferPickSeveral(found.length > 1 ? found.length : 0)
        getVp()?.setPickedLoops?.(chamferRef.current.loopIds)
        return
      }
      setModeledChamferPicking(false)
      setModeledChamferPickMissed(false)
      setModeledChamferPickSeveral(0)
      getVp()?.setLoopPickMode?.(null)
      applyModeledChamferPasses(chamferPassesFromModel(found, geoId, result.source))
    }, geoId && geoId !== '__all__' ? geoId : null)
  }
  const modeledChamferNote = modeledChamferRecord
    ? chamferAngleNote(modeledChamferRecord, selectedTool?.angleFromAxisDeg)
    : null
  const chamferStretch = isChamfer ? chamferStretchOf(chamfer as unknown as Record<string, unknown>) : null
  /** Create's extra operations, one per remaining pass. */
  const addModeledChamferSiblings = (commands: CamCommand[], computeIds: string[]): boolean => {
    if (!isChamfer || extraModeledPasses.length === 0 || !toolId) return false
    const targetSetupId = editingOpPayload?.setupId ?? setup.id
    const baseName = opName.trim() || tx('NewOperationModalBody.Census_Chamfer')
    extraModeledPasses.forEach((pass, index) => {
      const params = chamferParamsFromPass(chamfer, pass.record.geometryId, pass, modeledPassDatum(pass))
      const id = crypto.randomUUID()
      commands.push({ kind: 'operation.add', setupId: targetSetupId, operation: withRowHeightOverrides(withShankClearance({
        id,
        name: tx('NewOperationModalBody.Modeled_chamfer_pass_name', { p1: baseName, p2: index + 2 }),
        type: 'chamfer',
        enabled: true,
        status: 'pending',
        toolId,
        geometrySelections: [...params.loopIds],
        heights,
        passes,
        linking,
        feedrateOverride,
        params: params as unknown as Record<string, unknown>,
        smartHeight: chamferHeightAuthorityForDraft(params, params.loopIds),
      })) })
      computeIds.push(id)
    })
    setModeledChamferExtraPasses({ geoId: '', passes: [] })
    return true
  }
  const [chamferHeightPreview, setChamferHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if (!isChamfer || chamferHeightAuthority === 'repair_required' ||
        effectiveChamferLoopIds.length === 0 || !toolId) {
      const idleHandle = window.setTimeout(() => setChamferHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setChamferHeightPreview({ state: 'loading' })
      try {
        const params = chamferParamsForSave()
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__chamfer-smart-height-preview__', enabled: true, status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Chamfer_Smart_Height_preview'),
          type: 'chamfer',
          toolId,
          geometrySelections: [...params.loopIds],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: params as unknown as Record<string, unknown>,
          modelReferences: chamferPreviewModelReferences,
          smartHeight: chamferHeightAuthorityForDraft(),
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft, chamferSourceGeometries).then(
          plan => { if (current) setChamferHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setChamferHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setChamferHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 200)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  // The draft authority is rebuilt from these exact UI and project inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chamfer, chamferModelChainGeometry, editingOperation, feedrateOverride, heights, isChamfer, linking,
    opName, passes, previewOperationSmartHeightPlan, project.geometry, setup, toolId,
  ])

  // WO-1939: an edge chain picked on the modeled body IS this Engrave's path
  // set. Derived here exactly as store compute derives it (open paths kept), so
  // the saved path ids and Smart Height scope match what compute will see.
  // The source is looked up from project.geometry here (not the selectedGeo
  // local) so the React Compiler can keep this memo.
  const engraveModelChainGeometry = useMemo(() => {
    if (!isEngrave || !modelEdgeChain || geoId === '__all__') return null
    const chainGeo = project.geometry.find(g => g.id === geoId)
    if (chainGeo?.type !== 'model') return null
    const source = { modelItemId: chainGeo.modelItemId, bodyId: chainGeo.modelBody?.ref.bodyId }
    if (modelEdgeChainBodyMismatch(modelEdgeChain, source)) return null
    try {
      const derived = deriveModelBodyEdges(
        chainGeo, modelEdgeChain.edgeStableIds, project.modelItemPlacements ?? [],
        { openPaths: modelEdgeChainAllowsOpenPaths('engrave') },
      )
      return { ...chainGeo, loops: derived.loops }
    } catch {
      // finishModelEdgePick already showed the named refusal for this pick.
      return null
    }
  }, [isEngrave, modelEdgeChain, geoId, project.geometry, project.modelItemPlacements])
  const engraveSourceGeometries = isEngrave
    ? (engraveModelChainGeometry
        ? [engraveModelChainGeometry]
        : geoId === '__all__'
        ? resolveOpGeometrySources(project.geometry, '__all__', 'engrave')
        : project.geometry.filter(candidate => candidate.id === geoId))
    : []
  const eligibleEngraveLoopIds = engraveSourceGeometries.flatMap(geometry =>
    ((engraveModelChainGeometry ? geometry : geometryForOperation(geometry, 'engrave')).loops ?? [])
      .filter(loop => (loop.closed && engrave.includeClosed) || (!loop.closed && engrave.includeOpen))
      .map(loop => loop.id),
  )
  const effectiveEngraveLoopIds = isEngrave
    ? (engrave.loopIds.length > 0 && !engraveModelChainGeometry ? [...engrave.loopIds] : eligibleEngraveLoopIds)
    : []
  const [engraveRepairConfirmed, setEngraveRepairConfirmed] = useState(false)
  const engraveDepthDraftEdited = useRef(false)
  // WO-1969: the engraved path rides the part's top surface at the chosen
  // depth below it. Read from the edited op's V2 variant so a re-save keeps it.
  const editingEngraveFollowsSurface = () => {
    if (editingOperation?.type !== 'engrave' || editingOperation.smartHeight === undefined) return false
    const validated = validatePersistedSmartHeightState(editingOperation.smartHeight)
    return validated.ok && validated.state.kind === 'smart_v2' &&
      validated.state.intent.policy.variant === 'surface_following'
  }
  const [engraveFollowSurface, setEngraveFollowSurface] = useState(editingEngraveFollowsSurface)
  useEffect(() => {
    setEngraveFollowSurface(editingEngraveFollowsSurface())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingOperation?.id, isEditMode])
  const engraveHeightAuthority: 'smart_v2' | 'repair_required' =
    !heightRepairRequired || engraveRepairConfirmed ? 'smart_v2' : 'repair_required'
  const engraveParamsForSave = (): typeof engrave =>
    engraveHeightAuthority === 'smart_v2'
      ? { ...engrave, loopIds: [...effectiveEngraveLoopIds] }
      : engrave
  const engraveHeightAuthorityForDraft = (): Operation['smartHeight'] => ({
    kind: 'smart_v2',
    intent: buildEngraveSmartHeightIntent({
      setupId: setup.id,
      safetyIntent: operationSafetyIntent,
      datumReference: intentReferenceForUiReference(
        engrave.heightReference ?? 'geometry_face',
        'top',
      ) as Exclude<HeightReference, HeightPlaneName>,
      datumOffsetMm: engrave.planeOffset ?? 0,
      axialOffsetMm: engrave.axialOffset,
      depth: engrave.useWidthForDepth
        ? { kind: 'line_width', targetLineWidthMm: engrave.targetLineWidth }
        : { kind: 'explicit', depthMm: engraveExplicitDepthMm },
      ...(engraveFollowSurface ? { followSurface: true } : {}),
      scope: {
        geometryIds: engraveSourceGeometries.map(geometry => geometry.id),
        loopIds: [...effectiveEngraveLoopIds],
        includeOpen: engrave.includeOpen,
        includeClosed: engrave.includeClosed,
      },
    }),
  })
  const engraveSmartHeightForSave = (): Operation['smartHeight'] =>
    engraveHeightAuthority === 'smart_v2'
      ? engraveHeightAuthorityForDraft()
      : (() => { throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE) })()
  const [engraveHeightPreview, setEngraveHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    const explicitDepthReady = engrave.useWidthForDepth || engraveDepthEntered
    if (!isEngrave || engraveHeightAuthority === 'repair_required' ||
        effectiveEngraveLoopIds.length === 0 || !toolId || !explicitDepthReady) {
      const idleHandle = window.setTimeout(() => setEngraveHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setEngraveHeightPreview({ state: 'loading' })
      try {
        const params = engraveParamsForSave()
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__engrave-smart-height-preview__', enabled: true, status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_Engrave_Smart_Height_preview'),
          type: 'engrave',
          toolId,
          geometrySelections: [...params.loopIds],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: params as unknown as Record<string, unknown>,
          smartHeight: engraveHeightAuthorityForDraft(),
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft, engraveSourceGeometries).then(
          plan => { if (current) setEngraveHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setEngraveHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setEngraveHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 200)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  // The draft authority is rebuilt from these exact UI and project inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editingOperation, engrave, engraveDepthEntered, engraveExplicitDepthMm, engraveFollowSurface,
    feedrateOverride, heights, isEngrave, linking, opName, passes,
    previewOperationSmartHeightPlan, project.geometry, setup, toolId,
  ])

  // ── V-carve Smart Height authoring (WO-1174) ──────────────────────────────
  // WO-1940: an edge chain picked on the modeled body bounds this V-carve's
  // region. Derived exactly as store compute derives it (closed chains only),
  // so the saved region ids and Smart Height scope match what compute will see.
  const vcarveModelChainGeometry = useMemo(() => {
    if (!isVCarve || !modelEdgeChain || geoId === '__all__') return null
    const chainGeo = project.geometry.find(g => g.id === geoId)
    if (chainGeo?.type !== 'model') return null
    const source = { modelItemId: chainGeo.modelItemId, bodyId: chainGeo.modelBody?.ref.bodyId }
    if (modelEdgeChainBodyMismatch(modelEdgeChain, source)) return null
    try {
      const derived = deriveModelBodyEdges(
        chainGeo, modelEdgeChain.edgeStableIds, project.modelItemPlacements ?? [],
        modelEdgeChainDeriveOptions('vcarve'),
      )
      return { ...chainGeo, loops: derived.loops }
    } catch {
      // finishModelEdgePick already showed the named refusal for this pick.
      return null
    }
  }, [isVCarve, modelEdgeChain, geoId, project.geometry, project.modelItemPlacements])
  const vcarveSourceGeometries = isVCarve
    ? (vcarveModelChainGeometry
        ? [vcarveModelChainGeometry]
        : geoId === '__all__'
        ? resolveOpGeometrySources(project.geometry, '__all__', 'vcarve')
        : project.geometry.filter(candidate => candidate.id === geoId))
    : []
  const eligibleVCarveLoopIds = vcarveSourceGeometries.flatMap(geometry =>
    ((vcarveModelChainGeometry ? geometry : geometryForOperation(geometry, 'vcarve')).loops ?? [])
      .filter(loop => loop.closed).map(loop => loop.id),
  )
  const effectiveVCarveLoopIds = isVCarve
    ? (vcarve.loopIds.length > 0 && !vcarveModelChainGeometry ? [...vcarve.loopIds] : eligibleVCarveLoopIds)
    : []
  const [vcarveRepairConfirmed, setVCarveRepairConfirmed] = useState(false)
  const vcarveHeightAuthority: 'smart_v2' | 'repair_required' =
    !heightRepairRequired || vcarveRepairConfirmed ? 'smart_v2' : 'repair_required'
  const vcarveClearingTool = vcarve.flatClearing.mode === 'tool'
    ? toolLibrary.find(candidate => candidate.id === vcarveClearingToolId)
    : undefined
  /** The parameters the carve operation persists. In 'tool' clearing mode the
   *  clearing tool's diameter rides along so the bit knows what it leaves. */
  const vcarveParamsForSave = (): VCarveParams => ({
    ...vcarve,
    role: 'carve',
    loopIds: [...effectiveVCarveLoopIds],
    flatClearing: {
      ...vcarve.flatClearing,
      clearingToolDiameter: vcarve.flatClearing.mode === 'tool' ? vcarveClearingTool?.diameter : undefined,
    },
  })
  const vcarveHeightAuthorityForDraft = (flatDepth?: { kind: 'explicit'; depthMm: number } | { kind: 'tool_limit' }): Operation['smartHeight'] => ({
    kind: 'smart_v2',
    intent: buildVCarveSmartHeightIntent({
      setupId: setup.id,
      safetyIntent: operationSafetyIntent,
      datumReference: intentReferenceForUiReference(
        vcarve.heightReference ?? 'stock_top',
        'top',
      ) as Exclude<HeightReference, HeightPlaneName>,
      datumOffsetMm: vcarve.planeOffset ?? 0,
      startDepthMm: vcarve.startDepthMm,
      flatDepth: flatDepth ?? (vcarve.flatDepthMm !== undefined
        ? { kind: 'explicit', depthMm: vcarve.flatDepthMm }
        : { kind: 'tool_limit' }),
      scope: {
        geometryIds: vcarveSourceGeometries.map(geometry => geometry.id),
        loopIds: [...effectiveVCarveLoopIds],
      },
    }),
  })
  const vcarveSmartHeightForSave = (): Operation['smartHeight'] =>
    vcarveHeightAuthority === 'smart_v2'
      ? vcarveHeightAuthorityForDraft()
      : (() => { throw new Error(SMART_HEIGHT_V2_REPAIR_MESSAGE) })()
  /** The flat_clearing sibling of a carve: the flat_clearing op whose
   *  carveOpId names this carve (WO-1378 - not geometry/loop matching, which
   *  matched a duplicated carve to the ORIGINAL's sibling, BUG-416). */
  const vcarveSiblingOf = (carveOpId: string): Operation | undefined =>
    setup.operations.find(candidate => {
      if (candidate.id === carveOpId || candidate.type !== 'vcarve') return false
      const cp = candidate.params as unknown as PersistedVCarveParams
      return cp.role === 'flat_clearing' && cp.carveOpId === carveOpId
    })
  /** Keep the clearing sibling in step with the carve: create it, update it,
   *  or remove it when the operator stops using a separate tool. Refuses
   *  (ADR-0003) rather than saving a carve that expects a sibling nobody made. */
  const syncVCarveClearingSibling = (carveOpId: string, effective: VCarveParams, carveName: string, commands: CamCommand[], computeIds: string[]): void => {
    const existing = vcarveSiblingOf(carveOpId)
    if (effective.flatClearing.mode !== 'tool') {
      if (existing) commands.push({ kind: 'operation.remove', setupId: setup.id, operationId: existing.id })
      return
    }
    if (!vcarveClearingTool || !selectedTool) throw new Error(tx('NewOperationModalBody.Census_V_carve_choose_the_end_mill_that_clears_the'))
    const clearDepth = vcarveEffectiveMaxDepthMm()
    if (clearDepth === undefined) throw new Error(tx('NewOperationModalBody.Census_V_carve_tool_has_no_usable_tip_angle_so', { p1: selectedTool.name }))
    const clearingParams: PersistedVCarveParams = {
      ...effective,
      role: 'flat_clearing',
      flatDepthMm: clearDepth,
      vbit: { angleFromAxisDeg: selectedTool.angleFromAxisDeg ?? 45, tipDiameter: selectedTool.tipDiameter ?? 0 },
      carveOpId,
    }
    const patch = {
      name: tx('NewOperationModalBody.Census_flat_clearing', { p1: carveName }),
      toolId: vcarveClearingTool.id,
      geometrySelections: effective.loopIds,
      // WO-1940: the clearing sibling floors the same picked-edge region.
      modelReferences: vcarveModelReferences,
      heights,
      passes,
      linking,
      feedrateOverride,
      params: clearingParams as unknown as Record<string, unknown>,
      smartHeight: vcarveHeightAuthorityForDraft({ kind: 'explicit', depthMm: clearDepth }),
    }
    if (existing) {
      commands.push({ kind: 'operation.update', setupId: setup.id, operationId: existing.id, patch: {
        ...patch, status: 'pending', toolpathMoves: undefined, computeTimeMs: undefined, errorMessage: undefined,
      } })
      computeIds.push(existing.id)
      return
    }
    const clearingId = crypto.randomUUID()
    commands.push({ kind: 'operation.add', setupId: setup.id, operation: { id: clearingId, type: 'vcarve', enabled: true, status: 'pending', ...patch } })
    computeIds.push(clearingId)
  }
  /** The effective maximum depth the carve will use: the operator's flat depth
   *  or the selected bit's own limit. The clearing sibling gets it explicitly. */
  const vcarveEffectiveMaxDepthMm = (): number | undefined => {
    if (vcarve.flatDepthMm !== undefined) return vcarve.flatDepthMm
    if (!selectedTool) return undefined
    try { return vcarveToolLimitDepthMm(selectedTool) } catch { return undefined }
  }
  const [vcarveHeightPreview, setVCarveHeightPreview] =
    useState<LiveSmartHeightPreview>({ state: 'idle' })
  useEffect(() => {
    if (!isVCarve || vcarveHeightAuthority === 'repair_required' ||
        effectiveVCarveLoopIds.length === 0 || !toolId) {
      const idleHandle = window.setTimeout(() => setVCarveHeightPreview({ state: 'idle' }), 0)
      return () => window.clearTimeout(idleHandle)
    }
    let current = true
    const handle = window.setTimeout(() => {
      if (!current) return
      setVCarveHeightPreview({ state: 'loading' })
      try {
        const params = vcarveParamsForSave()
        const draft: Operation = {
          ...(editingOperation ?? {
            id: '__vcarve-smart-height-preview__', enabled: true, status: 'pending',
          }),
          name: opName.trim() || tx('NewOperationModalBody.Census_V_carve_Smart_Height_preview'),
          type: 'vcarve',
          toolId,
          geometrySelections: [...params.loopIds],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: params as unknown as Record<string, unknown>,
          smartHeight: vcarveHeightAuthorityForDraft(),
        } as Operation
        void previewOperationSmartHeightPlan(setup.id, draft, vcarveSourceGeometries).then(
          plan => { if (current) setVCarveHeightPreview({ state: 'resolved', plan }) },
          error => {
            if (current) setVCarveHeightPreview({
              state: 'error', message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      } catch (error) {
        if (current) setVCarveHeightPreview({
          state: 'error', message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 200)
    return () => {
      current = false
      window.clearTimeout(handle)
    }
  // The draft authority is rebuilt from these exact UI and project inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editingOperation, vcarve, vcarveClearingToolId, feedrateOverride, heights, isVCarve, linking, opName, passes,
    previewOperationSmartHeightPlan, project.geometry, setup, toolId,
  ])

  const activeHeightPreview: LiveSmartHeightPreview | undefined =
    (isParallel3d || isSteepShallow3d || isScallop3d || isPencil3d) ? parallel3dHeightPreview
      : isWaterline3d ? waterline3dHeightPreview
      : isAdaptive3d ? adaptive3dHeightPreview
        : isFace ? faceHeightPreview
          : isContour ? contourHeightPreview
            : (isDrill || isBore) ? drillBoreHeightPreview
              : (isPocket || isAdaptive) ? planarRoughHeightPreview
                : isThreadMill ? threadMillHeightPreview
                  : isChamfer ? chamferHeightPreview
                    : isEngrave ? engraveHeightPreview
                      : isVCarve ? vcarveHeightPreview
                        : undefined
  const activeResolvedHeightPlan = activeHeightPreview?.state === 'resolved'
    ? activeHeightPreview.plan
    : undefined
  // The last plan this operation type resolved. A live preview reloads after
  // every edit; a row edit made in that window seeds from this plan, never from
  // the legacy scalar heights the loading readout falls back to.
  const lastResolvedHeightPlanRef = useRef<{ opType: typeof opType; plan: ResolvedHeightPlanV2 } | null>(null)
  useEffect(() => {
    if (activeResolvedHeightPlan) lastResolvedHeightPlanRef.current = { opType, plan: activeResolvedHeightPlan }
  }, [activeResolvedHeightPlan, opType])

  const operationOwnsPrimaryHeightPlanes =
    isParallel3d || isWaterline3d || isSteepShallow3d || isScallop3d || isPencil3d || isAdaptive3d || isFace || isContour ||
    isDrill || isBore ||
    isPocket || isAdaptive || isThreadMill || isChamfer || isEngrave || isVCarve

  const standardHeightIntent = operationSafetyIntent

  function isOperationPlane(plane: HeightPlaneName): plane is 'top' | 'bottom' {
    return operationOwnsPrimaryHeightPlanes && (plane === 'top' || plane === 'bottom')
  }

  // The explicit WCS mode lower in the panel that currently owns this plane.
  function explicitModeWcs(plane: 'top' | 'bottom'): number | undefined {
    if (isAdaptive3d && adaptive3dHeightDraft.mode === 'bounded_band') {
      return plane === 'top' ? adaptive3dHeightDraft.topWcsMm : adaptive3dHeightDraft.bottomWcsMm
    }
    if ((isDrill || isBore) && drillBoreHeightDraft.mode === 'explicit_depth') {
      return plane === 'top' ? drillBoreHeightDraft.explicitStartWcsMm : drillBoreHeightDraft.explicitEndWcsMm
    }
    if (plane === 'bottom' && isFace && faceHeightChosen && faceHeightDraft.mode === 'explicit_depth') {
      return faceHeightDraft.explicitTargetWcsMm
    }
    if (plane === 'bottom' && isContour && contourHeightDraft.mode === 'explicit_depth') {
      return contourHeightDraft.explicitTargetWcsMm
    }
    if (plane === 'bottom' && planarGeometrySmartActive && heights.bottomHeightMode !== 'selected_face' &&
        planarRoughParams.heightReference === 'absolute') {
      return heights.bottomHeight
    }
    return undefined
  }

  // WO-1599: a geometry-bound Pocket / Adaptive Clearing has ONE bottom of cut:
  // its end reference + offset. The Bottom Height row, End condition and the
  // custom reference fields are all views of it, so there is no second writer.
  const planarRowOwnsBottom = planarRoughUsesGeometryScope && !rowPlaneOverrides.bottom

  /** The Bottom Height row's formula for that one state, in row vocabulary. */
  function planarBottomRowFormula(): { reference: HeightReference; offset: number } | undefined {
    if (planarRoughGeometryMode === 'geometry_floor') return undefined
    const reference = planarRoughParams.heightReference ?? 'geometry_face'
    const offset = planarRoughParams.planeOffset ?? 0
    if (reference === 'absolute') return { reference: 'wcs_plane', offset: heights.bottomHeight }
    const rowReference = PLANAR_BOTTOM_ROW_REFERENCE[reference]
    if (rowReference) return { reference: rowReference, offset }
    const target = planarRoughExplicitTargetWcs()
    return target === undefined ? undefined : { reference: 'wcs_plane', offset: target }
  }

  /** WO-1602: the reference a Clearance / Retract / Feed row names is the one
   * the operation's Smart intent carries, read from the builder that authors it.
   * WO-1616: a 3D surface finish's resolver binds the untouched Stock top default
   * to the model Top when no stock is proven (bindUnprovenStockTopSafety); the
   * row applies that same bind to the evidence its resolved plan used, so the
   * words name the plane the number came from. Safety planes never read target
   * geometry, so a stand-in id serves before a solid is picked. Every other
   * builder passes the reference through. */
  function authoredSafetyReference(plane: OperationSafetyPlane): HeightReference {
    const input = { setupId: setup.id, geometryIds: ['__safety-row__'], safetyIntent: operationSafetyIntent }
    const finishIntent = (isParallel3d || isSteepShallow3d || isScallop3d || isPencil3d)
      ? buildParallel3dSmartIntent(input)
      : isWaterline3d ? buildWaterline3dSmartIntent(input) : undefined
    if (!finishIntent) return operationSafetyIntent[plane].reference
    if (!activeResolvedHeightPlan) return finishIntent.safety[plane].reference
    // A plan that measured a safety plane from the stock top used the proven
    // stock's evidence node, so its evidence graph answers the same question.
    return bindUnprovenStockTopSafety(finishIntent, {
      revision: activeResolvedHeightPlan.revision,
      operationType: activeResolvedHeightPlan.policy.operationType,
      wcsOriginMachineMm: setup.wcs.origin.z,
      evidence: activeResolvedHeightPlan.evidenceGraph,
    }).safety[plane].reference
  }

  /** WO-1602: a height reference as the rows show it - another row's number, or
   * the live stock/model/WCS plane. Undefined when it cannot be resolved yet. */
  function rowReferenceWcs(
    reference: HeightReference,
    resolving: ReadonlySet<HeightPlaneName>,
  ): number | undefined {
    if (reference === 'wcs_plane') return 0
    if (reference === 'clearance' || reference === 'retract' || reference === 'feed' ||
        reference === 'top' || reference === 'bottom') {
      return resolving.has(reference) ? undefined : standardResolvedWcs(reference, resolving)
    }
    if (reference === 'stock_top' || reference === 'stock_bottom') {
      // The setup's proven stock is the evidence the plan itself reads; it
      // needs no picked geometry.
      const stockId = setupProvenStockId(setup, project)
      const bounds = stockId ? smartHeightStockBounds(project, stockId) : null
      if (bounds) return (reference === 'stock_top' ? bounds.max.z : bounds.min.z) - setup.wcs.origin.z
    }
    return resolveIntentReferenceWcsZ(reference, heights)
  }

  function standardResolvedWcs(
    plane: HeightPlaneName,
    resolving: ReadonlySet<HeightPlaneName> = new Set(),
  ): number | undefined {
    if (!activeResolvedHeightPlan) {
      // WO-1602: before a plan resolves, a safety row's number is its own
      // formula resolved, never the legacy scalar the formula does not govern.
      if (plane === 'clearance' || plane === 'retract' || plane === 'feed') {
        const base = rowReferenceWcs(authoredSafetyReference(plane), new Set([...resolving, plane]))
        return base === undefined ? undefined : base + standardHeightIntent[plane].offset
      }
      if (isOperationPlane(plane)) {
        if (plane === 'bottom' && planarRowOwnsBottom) {
          return planarRoughGeometryMode === 'explicit_depth' ? planarRoughExplicitTargetWcs() : undefined
        }
        const override = rowPlaneOverrides[plane]
        if (override?.reference === 'wcs_plane') return override.offsetMm
        const explicit = explicitModeWcs(plane)
        if (!override && explicit !== undefined) return explicit
        // The row's words state this override; its number is the same formula
        // resolved, never a legacy scalar the override does not govern.
        if (override) {
          const base = standardReferenceWcs(override.reference, heights)
          return base === undefined ? undefined : base + override.offsetMm
        }
      }
      return heightValue(heights, plane)
    }
    if (plane === 'clearance') return activeResolvedHeightPlan.safety.clearance.wcsMm
    if (plane === 'retract') return activeResolvedHeightPlan.safety.retract.wcsMm
    if (plane === 'feed') {
      return activeResolvedHeightPlan.safety.feed.wcsMm
    }
    if (plane === 'top') return activeResolvedHeightPlan.machining.materialStart.wcsMm
    return resolvedPlanTargetEndWcs(activeResolvedHeightPlan)
  }

  function standardHeightAuthority(plane: HeightPlaneName): 'Smart' | 'User Override' {
    // An operation's own Top/Bottom reads User Override when the operator set
    // that height, not when a policy builder records a picked floor as
    // user-owned bookkeeping (Pocket's geometry floor is its Smart default).
    if (isOperationPlane(plane)) {
      if (rowPlaneOverrides[plane] || explicitModeWcs(plane) !== undefined) return tx('NewOperationModalBody.User_Override')
      if (plane === 'bottom' && activeResolvedHeightPlan?.machining.featureEndpoints?.some(endpoint =>
        endpoint.cutterCenterEnd.owner.kind === 'user_override')) return tx('NewOperationModalBody.User_Override')
      if (plane === 'bottom' && (isPocket || isAdaptive) && planarGeometrySmartActive &&
          planarRoughGeometryMode !== 'geometry_floor') return tx('NewOperationModalBody.User_Override')
      return tx('NewOperationModalBody.Smart')
    }
    if (!activeResolvedHeightPlan) {
      return (plane === 'clearance' || plane === 'retract' || plane === 'feed') &&
        userSafetyOverridePlanes.has(plane)
        ? tx('NewOperationModalBody.User_Override')
        : tx('NewOperationModalBody.Smart')
    }
    const owner = plane === 'clearance'
      ? activeResolvedHeightPlan.safety.clearance.owner
      : plane === 'retract'
        ? activeResolvedHeightPlan.safety.retract.owner
        : plane === 'feed'
          ? activeResolvedHeightPlan.safety.feed.owner
          : plane === 'top'
            ? activeResolvedHeightPlan.machining.materialStart.owner
            : activeResolvedHeightPlan.machining.featureEndpoints?.some(endpoint =>
                endpoint.cutterCenterEnd.owner.kind === 'user_override')
              ? { kind: 'user_override' as const }
              : activeResolvedHeightPlan.machining.cutterCenterEnd?.owner
                ?? activeResolvedHeightPlan.machining.physicalTarget?.owner
    return owner?.kind === 'user_override' ? tx('NewOperationModalBody.User_Override') : tx('NewOperationModalBody.Smart')
  }

  // WO-1602: the diagram draws the safety planes the rows state.
  const diagramHeights: HeightParams = {
    ...heights,
    clearanceHeight: standardResolvedWcs('clearance') ?? heights.clearanceHeight,
    retractHeight: standardResolvedWcs('retract') ?? heights.retractHeight,
    feedHeight: standardResolvedWcs('feed') ?? heights.feedHeight,
  }

  function standardHeightFormula(plane: HeightPlaneName): {
    reference?: HeightReference
    sourceLabel: string
    offset?: number
    editable: boolean
    smartLabel?: string
  } {
    if (isOperationPlane(plane)) {
      const smartLabel = (isDrill || isBore)
        ? plane === 'top'
          ? tx('NewOperationModalBody.Current_material')
          : isDrill ? tx('NewOperationModalBody.Detected_floors_drill_point_breakthrough') : tx('NewOperationModalBody.Detected_floors_breakthrough')
        : tx('NewOperationModalBody.Operation_Smart_policy')
      if (plane === 'bottom' && planarRowOwnsBottom) {
        const planar = planarBottomRowFormula()
        if (!planar) return { sourceLabel: smartLabel, offset: undefined, editable: true, smartLabel }
        return {
          reference: planar.reference,
          sourceLabel: heightReferenceLabel(planar.reference),
          offset: planar.offset,
          editable: true,
          smartLabel,
        }
      }
      const override = rowPlaneOverrides[plane]
      const explicit = explicitModeWcs(plane)
      const reference = override?.reference ?? (explicit !== undefined ? 'wcs_plane' : undefined)
      if (!reference) return { sourceLabel: smartLabel, offset: undefined, editable: true, smartLabel }
      return {
        reference,
        sourceLabel: STANDARD_HEIGHT_ROWS
          .find(row => row.plane === plane)?.references
          .find(option => option.value === reference)?.label ?? reference,
        offset: override ? override.offsetMm : explicit,
        editable: true,
        smartLabel,
      }
    }
    const formula = { ...standardHeightIntent[plane], reference: authoredSafetyReference(plane) }
    const sourceLabel = STANDARD_HEIGHT_ROWS
      .find(row => row.plane === plane)?.references
      .find(option => option.value === formula.reference)?.label ?? formula.reference
    return { ...formula, sourceLabel, editable: true }
  }

  function resolveIntentReferenceWcsZ(
    reference: Exclude<HeightReference, HeightPlaneName>,
    currentHeights: HeightParams,
  ): number | undefined {
    if (reference === 'selected_feature_top' || reference === 'selected_feature_bottom') {
      if (currentHeights.selectedFaceZ === undefined || !selectedGeo) return undefined
      return resolveGeometryZToFrames(currentHeights.selectedFaceZ, selectedGeo, setup).wcsZ
    }
    if (reference === 'model_bottom') {
      if (!geoId || (geoId !== '__all__' && !selectedGeo)) return undefined
      try {
        return resolveModelBottomZ(project.geometry, geoId, setup.wcs.origin.z, project.stocks, selectedLoopIds)
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
        && (!geoId || (geoId !== '__all__' && !selectedGeo))) return undefined
    return resolveRefZ(uiReference, 0, geoId, selectedLoopIds)
  }

  function standardReferenceWcs(
    reference: HeightReference,
    currentHeights: HeightParams,
  ): number | undefined {
    if (reference === 'clearance' || reference === 'retract' || reference === 'feed' ||
        reference === 'top' || reference === 'bottom') {
      return heightValue(currentHeights, reference)
    }
    if (reference === 'wcs_plane') return 0
    return resolveIntentReferenceWcsZ(reference, currentHeights)
  }

  const editStandardHeightReference = (
    plane: HeightPlaneName,
    reference: HeightReference,
  ) => {
    markUserSafetyOverride(plane)
    // WO-1602: a new reference keeps the height the row shows in effect.
    const shownWcs = standardResolvedWcs(plane)
    const shownBaseWcs = rowReferenceWcs(reference, new Set([plane]))
    const shown = shownWcs !== undefined && shownBaseWcs !== undefined
    setHeights(current => {
      const baseWcs = shown ? shownBaseWcs : standardReferenceWcs(reference, current)
      const currentWcs = shown ? shownWcs : heightValue(current, plane)
      const offset = baseWcs === undefined ? currentWcs : currentWcs - baseWcs
      return {
        ...current,
        heightIntent: heightIntentAfterReferenceEdit(current, plane, reference, offset),
      }
    })
  }

  const editStandardHeightOffset = (
    plane: HeightPlaneName,
    reference: HeightReference,
    offset: number,
  ) => {
    markUserSafetyOverride(plane)
    setHeights(current => {
      const baseWcs = standardReferenceWcs(reference, current)
      const resolvedWcs = baseWcs === undefined ? offset : baseWcs + offset
      return {
        ...current,
        ...heightValuePatch(plane, resolvedWcs),
        heightIntent: heightIntentAfterReferenceEdit(current, plane, reference, offset),
      }
    })
  }

  // ── Top/Bottom Height rows of an operation that owns them (WO-1544) ─────────
  // A WCS value goes into the explicit mode lower in the panel when the
  // operation has one, so the number lives in one place and shows in both. Any
  // other reference is the operator's override on the Smart policy. The Smart
  // option returns the plane to the policy.
  const operationHasExplicitMode = (plane: 'top' | 'bottom') =>
    isAdaptive3d || isDrill || isBore ||
    (plane === 'bottom' && (isFace || isContour || planarRoughUsesGeometryScope))

  /** WO-2514: a Drill breaking through has its tip the drill point and the
   * breakthrough below the plane the operator set, and an authored Bottom (an
   * explicit Target End or a Bottom row) gets both added again. A plane seeded
   * from the resolved tip therefore starts that far up, so the tip stays put. */
  function authoredBottomFromTip(tip: number | undefined): number | undefined {
    if (tip === undefined || !isDrill || !selectedTool) return tip
    try {
      const allowances = drillBoreEndAllowancesMm({
        operationType: 'drill', mode: 'explicit_depth', tool: selectedTool, breakthroughMm: drill.breakthroughMm,
      })
      return tip + allowances.pointCompensationMm + allowances.breakthroughMm
    } catch {
      return tip
    }
  }

  /** The plane in effect, as the value an authored Top/Bottom takes so nothing
   * moves: a resolved plan's Bottom is the tip, folded back to its plane. */
  function latestResolvedWcs(plane: 'top' | 'bottom'): number | undefined {
    if (activeResolvedHeightPlan) {
      return plane === 'bottom' ? authoredBottomFromTip(standardResolvedWcs(plane)) : standardResolvedWcs(plane)
    }
    const override = rowPlaneOverrides[plane]
    if (override?.reference === 'wcs_plane') return override.offsetMm
    const explicit = explicitModeWcs(plane)
    if (!override && explicit !== undefined) return explicit
    const last = lastResolvedHeightPlanRef.current
    if (last?.opType === opType) {
      return plane === 'top'
        ? last.plan.machining.materialStart.wcsMm
        : authoredBottomFromTip(resolvedPlanTargetEndWcs(last.plan))
    }
    return standardResolvedWcs(plane)
  }
  const { reason: drillBreakThroughNote, fieldRef: drillBreakThroughFieldRef, fieldKey: drillBreakThroughFieldKey,
    setByUser: setDrillBreakThroughByUser } = useDrillBreakThroughDefault(state, { isEditMode, setup, bottomRow: rowPlaneOverrides.bottom,
    sourceGeometries: drillBoreSourceGeometries, loopIds: effectiveDrillBoreLoopIds, rowReferenceWcs })

  function writeOperationExplicitWcs(plane: 'top' | 'bottom', wcs: number) {
    const other = plane === 'top' ? 'bottom' : 'top'
    // WO-1601: a band's other plane held as a WCS row value moves into the band
    // with it - one state, which the band field then shows. A reference (Stock
    // top + 2) stays the row's, so it keeps following the stock.
    const otherRowWcs = (isAdaptive3d || isDrill || isBore) && rowPlaneOverrides[other]?.reference === 'wcs_plane'
      ? rowPlaneOverrides[other]?.offsetMm
      : undefined
    const otherWcs = otherRowWcs ?? explicitModeWcs(other) ?? latestResolvedWcs(other)
    if (otherRowWcs !== undefined) setRowPlaneOverride(other, undefined)
    setHeightRepairMessage(null)
    if (isAdaptive3d) {
      setAdaptive3dHeightAuthority('smart_v2')
      setAdaptive3dHeightDraft(current => ({
        mode: 'bounded_band',
        topWcsMm: plane === 'top' ? wcs : otherWcs ?? current.topWcsMm,
        bottomWcsMm: plane === 'bottom' ? wcs : otherWcs ?? current.bottomWcsMm,
      }))
    } else if (isDrill || isBore) {
      setDrillBoreHeightAuthority('smart_v2')
      setDrillBoreHeightDraft(current => ({
        mode: 'explicit_depth',
        explicitStartWcsMm: plane === 'top' ? wcs : otherWcs ?? current.explicitStartWcsMm,
        explicitEndWcsMm: plane === 'bottom' ? wcs : otherWcs ?? current.explicitEndWcsMm,
      }))
      if (isDrill) setDrill(current => ({ ...current, perHoleDepth: false }))
      else setBore(current => ({ ...current, perBoreDepth: false }))
    } else if (isPocket || isAdaptive) {
      setEndReference('absolute', wcs)
      setHeights(current => ({
        ...current, bottomHeight: wcs, bottomManual: true, bottomHeightMode: 'absolute', selectedFaceZ: undefined,
      }))
    } else if (isFace) {
      setFaceHeightDraft(current => ({ ...current, mode: 'explicit_depth', explicitTargetWcsMm: wcs }))
      setFaceHeightAuthority('smart_v2')
      setFaceHeightConfirmed(true)
    } else if (isContour) {
      setContourHeightDraft(current => ({ ...current, mode: 'explicit_depth', explicitTargetWcsMm: wcs }))
      setContourHeightAuthority('smart_v2')
    }
    setRowPlaneOverride(plane, undefined)
  }

  function returnOperationPlaneToSmart(plane: 'top' | 'bottom') {
    const other = plane === 'top' ? 'bottom' : 'top'
    const explicitOther = explicitModeWcs(other)
    if (explicitModeWcs(plane) !== undefined) {
      if (isAdaptive3d) {
        setAdaptive3dHeightDraft(current => ({ ...current, mode: 'current_material' }))
      } else if (isDrill || isBore) {
        setDrillBoreHeightDraft(current => ({ ...current, mode: 'detected_features' }))
        if (isDrill) setDrill(current => ({ ...current, perHoleDepth: true }))
        else setBore(current => ({ ...current, perBoreDepth: true }))
      } else if (isPocket || isAdaptive) {
        setEndCondition('to_geometry')
      } else if (isFace) {
        setFaceHeightDraft(current => ({ ...current, mode: 'target_face' }))
      } else if (isContour) {
        setContourHeightDraft(current => ({ ...current, mode: 'selected_feature' }))
      }
      // A band's other plane stays exactly where the operator put it.
      if ((isAdaptive3d || isDrill || isBore) && explicitOther !== undefined && !rowPlaneOverrides[other]) {
        setRowPlaneOverride(other, {
          reference: 'wcs_plane', offsetMm: explicitOther, owner: { kind: 'user_override' },
        })
      }
    }
    setRowPlaneOverride(plane, undefined)
  }

  // ── WO-1601: the lower height policy of Contour, Face, Drill/Bore, Adaptive 3D ─
  // Their drafts hold a preset or a WCS number, never a reference + offset, so a
  // row reference ("Stock bottom + 1.35") lives in planeOverrides and owns that
  // plane: folding it into a WCS number would stop it following the stock. The
  // policy selector therefore names the row's value as the one in effect, the
  // fields it overrides are not shown, and choosing a policy there replaces the
  // row's value in the open and says so in the console.
  const policyPlanes: ReadonlyArray<'top' | 'bottom'> = (isAdaptive3d || isDrill || isBore) ? ['top', 'bottom'] : ['bottom']
  const heldByRow = (plane: 'top' | 'bottom') => (isAdaptive3d || isDrill || isBore || isFace || isContour) &&
    policyPlanes.includes(plane) && rowPlaneOverrides[plane] !== undefined
  const policyHeldByRow = policyPlanes.some(heldByRow)
  // Adaptive 3D's Material source sets only where cutting starts (the top) unless
  // it is the explicit band, so a Bottom row alone leaves the chosen source in
  // effect and the dropdown keeps naming it.
  const adaptive3dSourceHeldByRow = heldByRow('top') ||
    (adaptive3dHeightDraft.mode === 'bounded_band' && policyHeldByRow)

  function rowOverrideText(plane: 'top' | 'bottom'): string {
    const override = rowPlaneOverrides[plane]
    if (!override) return ''
    const offset = override.offsetMm
    return `${heightReferenceLabel(override.reference)} ${offset >= 0 ? '+' : '-'} ${
      fmtDim(Math.abs(offset), displayUnits)} ${unitLabel(displayUnits)}`
  }

  /** The held option's words: the row value in effect. A plane the row does
   * not hold keeps its own fields below, which say what sets it. */
  function policyHeldLabel(): string {
    const held = policyPlanes.filter(heldByRow)
    if (held.length === 2) return tx('NewOperationModalBody.Height_rows_to', { p1: rowOverrideText('top'), p2: rowOverrideText('bottom') })
    return held.map(plane => tx('NewOperationModalBody.Height_row', { p1: plane === 'top' ? tx('NewOperationModalBody.Top') : tx('NewOperationModalBody.Bottom'), p2: rowOverrideText(plane) })).join('')
  }

  /** The operator chose a policy over the row's value: seed every explicit
   * field from what was in effect, so nothing moves until they type, drop the
   * row's value, and say so. */
  function replaceRowHeldPlanes(choiceLabel: string): Partial<Record<'top' | 'bottom', number>> {
    const held = policyPlanes.filter(heldByRow)
    if (held.length === 0) return {}
    const inEffect: Partial<Record<'top' | 'bottom', number>> = {}
    for (const plane of policyPlanes) {
      const wcs = latestResolvedWcs(plane)
      if (wcs !== undefined) inEffect[plane] = wcs
    }
    useCamStore.getState().addConsoleEvent({
      severity: 'info', source: 'operation',
      message: tx('NewOperationModalBody.Census_replaced_by', { p1: held.map(plane => tx('NewOperationModalBody.Census_Height', { p1: plane === 'top' ? tx('NewOperationModalBody.Top') : tx('NewOperationModalBody.Bottom'), p2: rowOverrideText(plane) })).join(tx('NewOperationModalBody.Census_and')), p2: choiceLabel }),
    })
    return inEffect
  }

  const editOperationHeightOffset = (
    plane: 'top' | 'bottom',
    reference: HeightReference | undefined,
    offset: number,
  ) => {
    const authoredReference = reference ?? 'wcs_plane'
    if (plane === 'bottom' && planarRoughUsesGeometryScope) {
      // WO-1599: the row writes the operation's one end state, which End
      // condition then shows as the same plane - never a second value.
      setCustomEndCondition(false)
      const endReference = PLANAR_BOTTOM_END_REFERENCE[authoredReference]
      if (endReference) {
        setEndReference(endReference, offset)
        return
      }
      const base = authoredReference === 'wcs_plane' ? 0 : standardReferenceWcs(authoredReference, heights)
      if (base !== undefined) {
        writeOperationExplicitWcs(plane, base + offset)
        return
      }
    }
    if (authoredReference === 'wcs_plane' && operationHasExplicitMode(plane)) {
      writeOperationExplicitWcs(plane, offset)
      return
    }
    // A Face bottom set from the row names its finished plane, so nothing is
    // left to confirm below.
    if (isFace && plane === 'bottom') setFaceHeightConfirmed(true)
    setRowPlaneOverride(plane, {
      reference: authoredReference, offsetMm: offset, owner: { kind: 'user_override' },
    })
  }

  const editOperationHeightReference = (plane: 'top' | 'bottom', choice: string) => {
    if (choice === SMART_ROW_OPTION) {
      if (plane === 'bottom' && planarRoughUsesGeometryScope) setEndCondition('to_geometry')
      else returnOperationPlaneToSmart(plane)
      return
    }
    const reference = choice as HeightReference
    const resolved = latestResolvedWcs(plane)
    if (reference === 'wcs_plane') {
      editOperationHeightOffset(plane, reference, resolved ?? 0)
      return
    }
    // Keep the resolved height where it is when the reference changes.
    const base = reference === 'top'
      ? latestResolvedWcs('top')
      : standardReferenceWcs(reference, heights)
    editOperationHeightOffset(
      plane,
      reference,
      resolved !== undefined && base !== undefined ? resolved - base : 0,
    )
  }

  // WO-1599: a Bottom Height override that reached a geometry-bound Pocket /
  // Adaptive Clearing some other way (a saved operation, or a stock boundary
  // switched to geometry) is folded into the end state it competed with, so the
  // plane it named is kept and End condition shows it.
  useEffect(() => {
    const competing = rowPlaneOverrides.bottom
    if (!planarRoughUsesGeometryScope || !competing) return
    if (competing.reference === 'wcs_plane' || PLANAR_BOTTOM_END_REFERENCE[competing.reference]) {
      editOperationHeightOffset('bottom', competing.reference, competing.offsetMm)
      return
    }
    const base = competing.reference === 'top'
      ? activeResolvedHeightPlan?.machining.materialStart.wcsMm
      : standardReferenceWcs(competing.reference, heights)
    if (base !== undefined) writeOperationExplicitWcs('bottom', base + competing.offsetMm)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planarRoughUsesGeometryScope, rowPlaneOverrides.bottom, activeResolvedHeightPlan])

  // ── 'picked_plane' MANUAL datum (UI for the committed resolver) ─────────────
  // The operator clicks ONE flat model face; we store its geometry-local Z on the
  // op's params.referencePlaneGeo. The resolver reads it ONLY when heightReference
  // === 'picked_plane' (plus the existing planeOffset on top), so this is purely
  // additive: every other reference behaves exactly as before, and we never clear
  // referencePlaneGeo when switching away (switching back restores it). The
  // accessor/setter span ALL ops that carry the field (pocket/chamfer included,
  // which keep their own dedicated reference blocks). The read accessor
  // (opReferencePlaneGeo) is defined earlier, next to resolveRefZ.
  const setOpReferencePlaneGeo = (geo: ReferencePlaneGeo | undefined) => {
    if (isContour)          setContour(c     => ({ ...c, referencePlaneGeo: geo }))
    else if (isDrill)       setDrill(d       => ({ ...d, referencePlaneGeo: geo }))
    else if (isBore)        setBore(b        => ({ ...b, referencePlaneGeo: geo }))
    else if (isThreadMill)  setThreadMill(t  => ({ ...t, referencePlaneGeo: geo }))
    else if (isFace)        setFace(f        => ({ ...f, referencePlaneGeo: geo }))
    else if (isEngrave)     setEngrave(e     => ({ ...e, referencePlaneGeo: geo }))
    else if (isVCarve)      setVCarve(v      => ({ ...v, referencePlaneGeo: geo }))
    else if (isAdaptive)    setAdaptive(a    => ({ ...a, referencePlaneGeo: geo }))
    else if (isPocket)      setPocket(p      => ({ ...p, referencePlaneGeo: geo }))
    else if (isChamfer)     setChamfer(c     => ({ ...c, referencePlaneGeo: geo }))
  }
  // Set heightReference to 'picked_plane' across ANY op. setOpHeightReference
  // spans only the generalized ops, so pocket/chamfer (own reference blocks) need
  // their own setters here.
  const setOpHeightReferenceAny = (ref: ChamferHeightReference) => {
    if (isPocket) {
      setRowPlaneOverride('bottom', undefined)
      const { heights: hUpd } = deriveHeightRefUpdate('pocket_2d', heights, pocket, ref)
      setPocket(p => ({ ...p, heightReference: ref }))
      setHeights(h => ({ ...h, ...hUpd }))
    }
    else if (isChamfer) {
      const { heights: hUpd } = deriveHeightRefUpdate('chamfer', heights, chamfer, ref)
      setChamfer(c => ({ ...c, heightReference: ref }))
      setHeights(h => ({ ...h, ...hUpd }))
    }
    else                 setOpHeightReference(ref)
  }
  // Single-shot MANUAL datum pick: click ONE flat model face; store its
  // geometry-local Z (deriveFaceLoops().z) as the reference plane. We do NOT land
  // a derived layer - only the Z is needed. FAIL-LOUD (ADR 0003) on a non-planar
  // (curved) pick: a cylinder wall is not a datum plane; we surface the error and
  // stay in pick mode without setting anything.
  const startReferencePlanePick = () => {
    if (!geoId) return
    setBrepDeriveError(null)
    // Collapse the modal to the floating pick banner (brepPickKind) so the
    // viewport is clickable - WITHOUT this the full modal covers the model and
    // the pick never engages. 'datum' is single-shot: one flat-face click
    // completes it (no Done button), a curved pick stays in the banner to retry.
    setBrepPickKind('datum')
    const vp = getVp()
    vp?.setPickedBrepSelections?.([])
    // Q-92: a datum plane is an INDEPENDENT reference, not part of the source
    // binding - referencePlaneGeo carries its own geoId. So the datum face may
    // be picked on any loaded solid, and body selection goes off while asking.
    const suspensionToken = useCamStore.getState().beginFacePickBodySelection(vp)
    const endDatumPick = () => {
      getVp()?.setBrepPickMode?.(null)
      useCamStore.getState().endFacePickBodySelection(suspensionToken, getVp())
      setBrepPickKind(null)  // restore the full modal
    }
    vp?.setBrepPickMode?.('face', (sel) => {
      void (async () => {
        try {
          // Fail loud rather than mis-blaming curvature: a modeled-body face
          // has no OCCT surface type at all and cannot resolve a datum Z here.
          if (sel.isModelFace) {
            setBrepDeriveError(tx('NewOperationModalBody.Datum_faces_come_from_an_imported_STEP_B_rep'))
            return  // stay in the datum banner so the user can re-pick
          }
          if (!sel.geoId || !project.geometry.some(g => g.id === sel.geoId)) {
            setBrepDeriveError(tx('NewOperationModalBody.The_picked_face_belongs_to_a_body_that_is'))
            return
          }
          if (sel.surfaceType !== 0) {
            setBrepDeriveError(tx('NewOperationModalBody.That_surface_is_curved_pick_a_FLAT_planar_face'))
            return  // stay in the datum banner so the user can re-pick a flat face
          }
          // The datum's owning geometry is the one the CLICK landed on.
          const r = await deriveFaceLoops(sel.geoId, sel.index)
          setOpReferencePlaneGeo({ geoId: sel.geoId, faceIndex: sel.index, localZ: r.z })
          setOpHeightReferenceAny('picked_plane')
          setBrepDeriveError(null)
          endDatumPick()
        } catch (err) {
          setBrepDeriveError(err instanceof Error ? err.message : String(err))
          endDatumPick()
        }
      })()
    }, null)
  }
  // Shared button + readout, rendered at each of the 3 reference dropdowns when
  // 'picked_plane' is selected, so the 3 sites stay identical.
  const renderPickedDatumBlock = () => {
    const datumGeo = opReferencePlaneGeo ? project.geometry.find(g => g.id === opReferencePlaneGeo.geoId) : undefined
    const wcsZ = opReferencePlaneGeo
      ? resolveGeometryZToFrames(opReferencePlaneGeo.localZ, datumGeo ?? undefined, setup).wcsZ
      : undefined
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {/* Q-92: '__all__' no longer disables the datum pick - the datum face
            carries its own geoId, so it never needed a single selected body. */}
        <button className="op-toggle-btn" data-testid="pick-datum-face"
          disabled={!geoId}
          onClick={startReferencePlanePick}>
          {opReferencePlaneGeo ? tx('NewOperationModalBody.Re_pick_face_on_model') : tx('NewOperationModalBody.Pick_face_on_model')}
        </button>
        <div className="op-pass-summary" data-testid="pick-datum-readout">
          <span>
            {opReferencePlaneGeo && wcsZ !== undefined
              ? tx('NewOperationModalBody.Datum_picked_face_WCS_Z_from_work_zero', { p1: fmtDim(wcsZ, displayUnits), p2: unitLabel(displayUnits) })
              : tx('NewOperationModalBody.No_surface_picked_yet_click_Pick_face_on_model')}
          </span>
        </div>
      </div>
    )
  }

  // Per-hole depths (manual override editor). One row per SELECTED hole, in
  // closedLoops (geometry) order — cheap + stable; the op's runtime sort order
  // (nearest-neighbour etc.) is a worker-side concern and would re-derive on
  // every keystroke. Empty selection == "all" (compute's contract), so the
  // editor lists every closed loop in that case. Center is the loop centroid;
  // diameter mirrors the loop-selector estimate (2*sqrt(area/PI)) so a B-rep
  // hole and a DXF/sketch circle read the SAME way without needing the
  // HoleFeature record. WCS-relative bottom Z is stored in mm via the unit
  // shim, same convention/sign as the op-level bottom-height field.
  const drillHoleRows = isDrill
    ? (selectedLoopIds.length === 0 ? closedLoops : closedLoops.filter(l => selectedLoopIds.includes(l.id)))
        .map((loop, i) => {
          let cx = 0, cy = 0
          if (loop.points.length > 0) {
            for (const p of loop.points) { cx += p.x; cy += p.y }
            cx /= loop.points.length; cy /= loop.points.length
          }
          return {
            id: loop.id,
            index: i + 1,
            cx, cy,
            diameterMm: 2 * Math.sqrt(Math.abs(loop.area) / Math.PI),
          }
        })
    : []

  // Per-hole DETECTED bottoms (display only). Mirrors the store dispatch
  // (store/index.ts ~3860): detected[loopId] =
  //   holeBottomWorldZ(hole, layer, geo) - setup.wcs.origin.z  (WCS-relative mm)
  // so the table placeholder shows the SAME value the toolpath uses when
  // "Per-hole depth (from model)" is on. Sourced from the SAME geometry set the
  // rows came from: the selected file, or every loaded file for '__all__'.
  // holeBottomWorldZ is imported (not re-derived) to keep display == output.
  const drillDetectedWcsRel: { [loopId: string]: number } = {}
  if (isDrill) {
    const detectGeoSources = isAllGeo ? allGeoSources : (selectedGeo ? [selectedGeo] : [])
    for (const g of detectGeoSources) {
      for (const layer of g.layers2d ?? []) {
        for (const h of layer.holes ?? []) {
          if (h.loopId) {
            drillDetectedWcsRel[h.loopId] = holeBottomWorldZ(h, layer, g) - setup.wcs.origin.z
          }
        }
      }
    }
  }

  // Per-hole RESOLVED bottoms (display only, BUG-407). drillDetectedWcsRel
  // above is the raw geometric floor; the operation actually cuts to that
  // floor plus the drill-point compensation and breakthrough allowances the
  // resolver applies (standardHeightFormula's "Detected floors + drill point /
  // breakthrough" label, a few lines up in this file). Reading the SAME
  // per-feature endpoint the modal's own resolved plan produces keeps the
  // tooltip's "auto" value equal to the depth the operation resolves, instead
  // of disagreeing with it by exactly those allowances.
  const drillResolvedWcsRel: { [loopId: string]: number } = {}
  if (isDrill && activeResolvedHeightPlan?.machining.featureEndpoints?.length) {
    const bindings = deriveDrillBoreFeatureBindings(
      drillBoreSourceGeometries, effectiveDrillBoreLoopIds, 'drill',
    )
    if (bindings.ok) {
      const sameFeature = (a: StableFeatureReference, b: StableFeatureReference) =>
        a.modelItemId === b.modelItemId && a.bodyId === b.bodyId && a.featureKind === b.featureKind &&
        a.stableId === b.stableId && a.sourceVersion === b.sourceVersion && a.sourceFingerprint === b.sourceFingerprint
      for (const binding of bindings.bindings) {
        const endpoint = activeResolvedHeightPlan.machining.featureEndpoints.find(candidate =>
          sameFeature(candidate.feature, binding.feature))
        if (endpoint) drillResolvedWcsRel[binding.loopId] = endpoint.cutterCenterEnd.wcsMm
      }
    }
  }

  // Depth estimates. When the top or bottom is bound to a picked model face
  // (selected_face mode), the stored heights.topHeight/bottomHeight can be STALE
  // (a recompute-heal sets selected_face + selectedFaceZ but does NOT rewrite the
  // legacy height field). Resolve through the SAME converter the height readout
  // uses (resolveGeometryZToFrames, see ~line 3401) so the pass count matches the
  // real cut depth instead of the stale stored value.
  const resolvedBottomForDepth = (heights.bottomHeightMode === 'selected_face' && heights.selectedFaceZ !== undefined)
    ? resolveGeometryZToFrames(heights.selectedFaceZ, selectedGeo ?? undefined, setup).wcsZ
    : heights.bottomHeight
  const resolvedTopForDepth = (heights.topHeightMode === 'selected_face' && heights.selectedFaceZ !== undefined)
    ? resolveGeometryZToFrames(heights.selectedFaceZ, selectedGeo ?? undefined, setup).wcsZ
    : heights.topHeight
  const depthRange = Math.abs(resolvedTopForDepth - resolvedBottomForDepth)
  const estPasses  = depthRange > 0 ? Math.ceil(depthRange / Math.max(0.01, passes.stepdown)) : 1

  // Contour cutting strategy -> emitted {stockToLeave, finishPasses, contourFinishMode}.
  // Single source of truth (the same helper the worker contract is tested against);
  // EVERY mode produces a real cut, so stockToLeave=0 && finishPasses=0 is unreachable.
  const contourEmit = contourPassParamsForMode(contourMode, {
    stockToLeave: passes.stockToLeave,
    finishPasses: passes.finishPasses,
  })
  // All Parts flattens loops from multiple files, while a WO-244 chain id is
  // content-derived and can therefore occur on two imported copies of the same
  // STL. Persist the source rows selected at authoring time so compute can
  // refuse a vanished chain instead of accepting the same id elsewhere.
  // WO-258: ONE binder for every family that may pick a chain (Contour, Pocket),
  // so the by-name refusal at the compute seam has the same evidence whichever
  // dialog authored the operation.
  // WO-2859: the saved binding is read from the one pick list
  // (`loopSelectionPicks`): a chain picked on named part instances keeps them as
  // authored, even when that part has since lost the chain (compute then names
  // it); a chain picked on no instance (viewport pick, All loops) binds every
  // live part carrying it. A binding no pick carries never reaches Save.
  const meshChainSourcesForSave = (
    loopIds: readonly string[],
    previous: Record<string, MeshChainSourceBinding[]> | undefined,
  ): Record<string, MeshChainSourceBinding[]> | undefined => {
    if (!isAllGeo) return undefined
    const picks = loopSelectionPicks({ geometryId: '__all__', loopIds: [...loopIds], meshChainSources: previous } as never)
    const meshChainSources: Record<string, MeshChainSourceBinding[]> = {}
    for (const chainId of [...new Set(loopIds)].filter(isMeshChainId)) {
      const authored = picks.flatMap((pick) => pick.loopId === chainId && pick.instance ? [pick.instance] : [])
      const bindings = authored.length
        ? authored.map((binding) => {
            const live = allGeoSources.find((geometry) => geometry.id === binding.geometryId)
            return live ? { geometryId: live.id, geometryName: live.name } : binding
          })
        : allGeoSources
          .filter((geometry) =>
            isStlChainSource(geometry) &&
            geometry.loops?.some((loop) => loop.id === chainId),
          )
          .map((geometry) => ({ geometryId: geometry.id, geometryName: geometry.name }))
      if (bindings.length) meshChainSources[chainId] = bindings
    }
    return Object.keys(meshChainSources).length > 0 ? meshChainSources : undefined
  }

  // The durable ModelReference an op's picked machining-boundary face folds
  // into on Save. The shared model-body capability map gates which operation
  // types can reach this state. undefined (not null) when no face is picked,
  // matching Operation.modelReferences' own optional shape.
  const selectedModelReferenceSource = selectedGeo?.type === 'model'
    ? { modelItemId: resolveOwningModelItemId(selectedGeo), bodyId: selectedGeo.modelBody?.ref.bodyId }
    : undefined
  const machiningBoundaryModelReferences = machiningBoundaryFace
      && modelReferenceMatchesSource(machiningBoundaryFace, selectedModelReferenceSource)
    ? [authorModelReference(
        machiningBoundaryFace.modelItemId ?? LEGACY_MODEL_ITEM_ID,
        machiningBoundaryFace.bodyId,
        [machiningBoundaryFace.faceStableId],
        'machining-boundary',
      )]
    : undefined
  // Stock-boundary adaptive operations are geometry-independent. Normalize
  // any model selection left in the modal draft before save so the shared
  // model-origin guard and amber invalidation cannot treat a stock operation
  // as body-bound. The explicit undefined also clears a stale durable face
  // reference when an older/editing operation is switched to Stock.
  const effectivePocket = pocket.boundarySource === 'stock'
    ? { ...pocket, geometryId: '', loopIds: [] }
    : pocket
  const effectiveAdaptive = adaptive.boundarySource === 'stock'
    ? { ...adaptive, geometryId: '', loopIds: [] }
    : adaptive
  const adaptiveMachiningBoundaryModelReferences =
    effectiveAdaptive.boundarySource === 'geometry' && selectedGeo?.type === 'model'
      ? machiningBoundaryModelReferences
      : undefined
  const drillTargetsModelReferences = modelDrillBinding
      && modelReferenceMatchesSource(modelDrillBinding, selectedModelReferenceSource)
    ? [authorModelReference(
        modelDrillBinding.modelItemId ?? LEGACY_MODEL_ITEM_ID,
        modelDrillBinding.bodyId,
        modelDrillBinding.stableIds,
        'drill-targets',
      )]
    : undefined
  const boreTargetModelReferences = modelBoreBindingForOp
      && modelReferenceMatchesSource(modelBoreBindingForOp, selectedModelReferenceSource)
    ? [authorModelReference(
        modelBoreBindingForOp.modelItemId ?? LEGACY_MODEL_ITEM_ID,
        modelBoreBindingForOp.bodyId,
        [modelBoreBindingForOp.faceStableId],
        'bore-target',
      )]
    : undefined

  // A modeled-body edge chain belongs only to the compound Model Item/body
  // identity on which it was picked. A source or operation-type switch drops
  // the effective binding and surfaces the reason instead of falling through.
  const modelEdgeChainSource = selectedGeo?.type === 'model'
    ? { modelItemId: selectedGeo.modelItemId, bodyId: selectedGeo.modelBody?.ref.bodyId }
    : undefined
  const modelEdgeChainBodyMismatched = modelEdgeChainBodyMismatch(modelEdgeChain, modelEdgeChainSource)
  const modelEdgeChainOpTypeUnsupported = modelEdgeChain !== null && !modelBodyEdgeChainBindingSupported(opType)
  const effectiveModelEdgeChain =
    modelEdgeChain && !modelEdgeChainBodyMismatched && !modelEdgeChainOpTypeUnsupported
      ? modelEdgeChain
      : null
  const modelEdgeChainDropNotice = modelEdgeChainBodyMismatched && modelEdgeChain
    ? modelEdgeChainMismatchMessage(
        modelEdgeChain, selectedGeo?.name ?? tx('NewOperationModalBody.no_source_selected'), modelEdgeChainSource,
      )
    : modelEdgeChainOpTypeUnsupported
    ? tx('NewOperationModalBody.A_operation_cannot_use_a_picked_modeled_body_edge', { p1: opType }) +
      tx('NewOperationModalBody.edges_you_picked_were_NOT_applied_to_it_Switch') +
      tx('NewOperationModalBody.Clearing_Engrave_V_Carve_or_Chamfer_or_clear_the')
    : null
  const modelEdgeChainModelReferences =
    effectiveModelEdgeChain && effectiveModelEdgeChain.edgeStableIds.length > 0
      ? [{
          bodyId: effectiveModelEdgeChain.bodyId,
          ...(effectiveModelEdgeChain.modelItemId !== undefined
            ? { modelItemId: effectiveModelEdgeChain.modelItemId }
            : {}),
          stableIds: [...effectiveModelEdgeChain.edgeStableIds],
          role: 'edge-chain' as const,
        }]
      : undefined
  // edge chain > face pick > loop ids: the precedence order for which
  // selection is this contour's effective machining-boundary input. Both the
  // Create-button readiness check (loopsExplicitlyEmpty, below) and the
  // save path (contourParamsForSave, below) key off this so a higher-
  // precedence selection is never blocked by an absent lower-precedence one,
  // and choosing one clears the fields a superseded one left behind.
  const contourModelReferences = modelEdgeChainModelReferences ?? machiningBoundaryModelReferences
  // WO-1924: Pocket and Adaptive Clearing take the same edge chain > face pick
  // precedence on a geometry boundary. A stock boundary is geometry-independent
  // and carries no model reference at all.
  const pocketEdgeChainModelReferences = effectivePocket.boundarySource === 'geometry'
    ? modelEdgeChainModelReferences
    : undefined
  const pocketModelReferences = effectivePocket.boundarySource === 'geometry'
    ? pocketEdgeChainModelReferences ?? machiningBoundaryModelReferences
    : undefined
  const adaptiveEdgeChainModelReferences = effectiveAdaptive.boundarySource === 'geometry'
    ? modelEdgeChainModelReferences
    : undefined
  const adaptiveModelReferences =
    adaptiveEdgeChainModelReferences ?? adaptiveMachiningBoundaryModelReferences
  // WO-2859: Adaptive takes STL chains on the same closed-only rule as Pocket,
  // so it saves the same All Parts chain bindings through the one binder.
  const adaptiveForSave: typeof effectiveAdaptive & {
    meshChainSources?: Record<string, MeshChainSourceBinding[]>
  } = {
    ...effectiveAdaptive,
    loopIds: contourLoopIdsForSave(effectiveAdaptive.loopIds, !!adaptiveEdgeChainModelReferences),
  }
  const adaptiveMeshChainSources = meshChainSourcesForSave(
    adaptiveForSave.loopIds,
    (adaptive as typeof adaptiveForSave).meshChainSources,
  )
  if (adaptiveMeshChainSources) adaptiveForSave.meshChainSources = adaptiveMeshChainSources
  else delete adaptiveForSave.meshChainSources
  // WO-1939: Engrave persists the chain it follows. Its path ids are the
  // chain-derived ones (engraveModelChainGeometry above), never a stale pick.
  const engraveModelReferences = engraveModelChainGeometry ? modelEdgeChainModelReferences : undefined
  // WO-1940: V-carve persists the chain whose region it carves, likewise.
  const vcarveModelReferences = vcarveModelChainGeometry ? modelEdgeChainModelReferences : undefined
  // WO-1941: Chamfer persists the chain whose loop it bevels, likewise.
  const chamferModelReferences = chamferModelChainGeometry ? modelEdgeChainModelReferences : undefined

  const pocketParamsForSave = (): PocketParams => {
    // WO-1924: a bound edge chain supersedes a loop-id selection exactly as it
    // does for Contour, so compute takes every derived chain loop.
    const normalized: PersistedPocketParams = pocket.boundarySource === 'stock'
      ? { ...pocket, geometryId: '', loopIds: [] }
      : { ...pocket, loopIds: contourLoopIdsForSave(pocket.loopIds, !!pocketEdgeChainModelReferences) }
    const bindings = meshChainSourcesForSave(
      normalized.loopIds,
      (pocket as PersistedPocketParams).meshChainSources,
    )
    if (bindings) normalized.meshChainSources = bindings
    else delete normalized.meshChainSources
    return normalized
  }
  const contourParamsForSave = (
    contourFinishMode: ContourParams['contourFinishMode'],
  ): ContourParams => {
    // edge chain > face pick > loop ids: once a higher-precedence source is
    // effective, a saved loop-id selection belongs to a superseded source and
    // must not survive to trip up compute's targetLoops filter (BUG-466).
    const effectiveLoopIds = contourLoopIdsForSave(contour.loopIds, !!contourModelReferences)
    const normalized: PersistedContourParams = {
      ...contour,
      loopIds: effectiveLoopIds,
      tabs: contourPathType === 'open' ? false : contour.tabs,
      contourFinishMode,
    }
    const bindings = meshChainSourcesForSave(
      effectiveLoopIds,
      (contour as PersistedContourParams).meshChainSources,
    )
    if (bindings) normalized.meshChainSources = bindings
    else delete normalized.meshChainSources
    if (contourPathType === 'open') {
      normalized.pathType = 'open'
      normalized.openSide = contour.openSide ?? 'right'
    } else {
      // Optional open-path fields must not alter the byte shape of legacy and
      // newly-authored closed contours.
      delete normalized.pathType
      delete normalized.openSide
    }
    return normalized
  }
  // Open contours currently support one truthful entry cycle: move outside
  // stock, plunge there, then feed onto the chain. Derive the persisted value
  // without changing the shared draft so switching back to closed restores the
  // user's ramp choice.
  const contourLinkingForSave = contourPathType === 'open'
    ? { ...linking, entryType: 'plunge' as const }
    : linking
  const effStockToLeave = contourEmit.stockToLeave
  const effFinishPasses = contourEmit.finishPasses
  // Which conditional fields the Passes tab shows for the current strategy.
  const contourShowsStockToLeave = contourMode !== 'cut_at_geometry'
  // Finish passes only make sense when there is roughing to finish. cut_at_geometry
  // has no roughing (its single profile pass IS the cut — repeats are spring passes)
  // and roughing_only has no finish, so the field shows only for the two rough+finish modes.
  const contourShowsFinishPasses = contourMode === 'rough_finish_each' || contourMode === 'rough_finish_final'

  // The per-loop selector is shown only when there are closed loops to pick from.
  // Face sourced from STOCK ignores loopIds, so an explicit clear there is moot.
  const loopSelectorVisible = (selectedGeo || isAllGeo) && closedLoops.length > 0 &&
    // WO-1820: 'rest' picks a contour too - it is the base the pockets are cut out of.
    !(isFace && face.boundarySource === 'stock') &&
    !(isPocket && pocket.boundarySource === 'stock') &&
    !(isAdaptive && adaptive.boundarySource === 'stock')
  // Excludes the selected loop IDs on purpose: picks emitted by the current
  // session update that selection and must not disarm themselves. Everything
  // that defines which viewport hits are eligible is included.
  const loopPickerContextKey = [
    opType,
    geoId,
    contourPathType,
    loopSelectorVisible ? 'loops-visible' : 'loops-hidden',
    closedLoops.map(loop => loop.id).join('\u001f'),
  ].join('\u001e')
  // ADR-0003 (no silent fallbacks): if the user explicitly cleared every loop, an
  // empty selection must NOT be silently treated as "all" by compute. Block Create
  // and say why, instead of quietly cutting everything. Exception: a Contour with
  // a higher-precedence source effective (a bound edge chain or a picked face,
  // contourModelReferences) has a valid machining boundary from THAT source - an
  // absent/cleared loop selection is moot and must not block Create (BUG-463).
  // WO-1924: a bound edge chain is the same superseding source for Pocket and
  // Adaptive Clearing.
  const authoringFacts: OperationAuthoringFacts = {
    type: opType,
    contourPathType,
    closedLoopCount: closedLoops.length,
    selectedLoopCount: selectedLoopIds.length,
    loopSelectorVisible,
    userClearedLoops,
    sourceSelected: !!(selectedGeo || isAllGeo),
    sourceIsModel: selectedGeo?.type === 'model',
    contourModelReferences: !!contourModelReferences,
    pocketEdgeChainModelReferences: !!pocketEdgeChainModelReferences,
    adaptiveEdgeChainModelReferences: !!adaptiveEdgeChainModelReferences,
    engraveModelReferences: !!engraveModelReferences,
    vcarveModelReferences: !!vcarveModelReferences,
    chamferModelReferences: !!chamferModelReferences,
    heightRepairRequired,
    faceHeightChosen,
    planarStockSmartActive,
    planarGeometrySmartActive,
    engraveUseWidthForDepth: engrave.useWidthForDepth,
    engraveDepthEntered,
    vcarveClearingToolPresent: !!vcarveClearingTool,
    pencilCutterSupported,
    parallelCutterSupported,
    cutter3dSupported,
    adaptive3dBandValid,
    toolId,
    parallelHeightPartIdEff,
    waterline3dPartIdEff,
    adaptive3dPartIdEff,
    threadMillHeightAuthority,
    chamferHeightAuthority,
    engraveHeightAuthority,
    vcarveHeightAuthority,
    vcarveClearingMode: vcarve.flatClearing.mode,
    faceHeightPreview,
    planarRoughHeightPreview,
    contourHeightPreview,
    drillBoreHeightPreview,
    threadMillHeightPreview,
    chamferHeightPreview,
    engraveHeightPreview,
    vcarveHeightPreview,
    parallel3dHeightPreview,
    waterline3dHeightPreview,
    adaptive3dHeightPreview,
  }
  const authoring = operationAuthoringDecision(authoringFacts, tx)
  const { loopsExplicitlyEmpty, contourHasNoEligiblePaths, planarRoughHeightValid, contourHeightValid, drillBoreHeightValid, threadMillHeightValid, chamferHeightValid, engraveHeightValid, vcarveHeightValid } = authoring

  const callableMacros = callableMachineMacros(project.machine)
  const selectedRunMacro = callableMacros.find((macro) => macro.id === runMacroId)
  const canCreate = machineActionKind !== null
    ? (machineActionKind !== 'run_macro' || selectedRunMacro !== undefined)
    : authoring.canCreate

  const selectOperationType = (nextType: typeof opType) => {
    if (nextType !== opType) setUserClearedLoops(true)
    setOpType(nextType)
    setMachineActionKind(null)
  }

  const startFaceTargetPlanePick = () => {
    setBrepDeriveError(null)
    setBrepPickKind('face-target')
    const vp = getVp()
    vp?.setPickedBrepSelections?.([])
    useCamStore.getState().beginFacePickBodySelection(vp)
    const finish = () => {
      getVp()?.setBrepPickMode?.(null)
      useCamStore.getState().endFacePickBodySelection(null, getVp())
      setBrepPickKind(null)
    }
    vp?.setBrepPickMode?.('face', (sel) => {
      void (async () => {
        try {
          if (sel.isModelFace) {
            setBrepDeriveError(tx('NewOperationModalBody.Smart_Face_targets_currently_require_a_flat_face_on'))
            return
          }
          if (!sel.geoId || !project.geometry.some(candidate => candidate.id === sel.geoId)) {
            setBrepDeriveError(tx('NewOperationModalBody.The_picked_target_face_belongs_to_a_solid_that'))
            return
          }
          if (sel.surfaceType !== 0) {
            setBrepDeriveError(tx('NewOperationModalBody.The_finished_Face_target_must_be_flat_Pick_a'))
            return
          }
          const derived = await deriveFaceLoops(sel.geoId, sel.index)
          setFace(current => ({
            ...current,
            targetPlaneGeo: { geoId: sel.geoId, faceIndex: sel.index, localZ: derived.z },
          }))
          setFaceHeightDraft(current => ({ ...current, mode: 'target_face' }))
          setFaceHeightAuthority('smart_v2')
          setFaceHeightConfirmed(true)
          setBrepDeriveError(null)
          finish()
        } catch (error) {
          setBrepDeriveError(error instanceof Error ? error.message : String(error))
          finish()
        }
      })()
    }, null)
  }

  const resetState = () => {
    activeLoopPickSessions.delete(setIsPickingLoops)
    loopPickAcceptedRef.current = null
    setTab('type'); setOpType('contour_2d'); setMachineActionKind(null)
    setOpName(''); setToolId('')
    setHeights(defaultHeights); setCustomEndCondition(false); setPasses(defaultPasses)
    setUserSafetyOverridePlanes(new Set())
    setLinking(defaultLinking)
    setContour(defaultContourParams); setPocket(defaultPocketParams)
    setContourHeightDraft({ mode: 'selected_feature', explicitTargetWcsMm: -5, throughAllowanceMm: 0.5 })
    setContourHeightAuthority('new')
    setDrillBoreHeightDraft({ mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 })
    setDrillBoreHeightAuthority('new')
    setMachiningBoundaryFace(null); setMachiningBoundaryPickActive(false); setMachiningBoundaryPickError(null)
    setModelDrillBinding(null)
    setModelBoreBinding(null)
    setDrill(defaultDrillParams); state.setDrillBreakthroughSetByUser(false)
    setBore(defaultBoreParams)
    setThreadMill(defaultThreadMillParams)
    setThreadMillRepairConfirmed(false)
    setChamfer(defaultChamferParams)
    setChamferRepairConfirmed(false)
    setFace(defaultFaceParams)
    setEngrave(defaultEngraveParams)
    setEngraveRepairConfirmed(false)
    setEngraveExplicitDepthMm(1)
    setEngraveDepthEntered(false)
    setEngraveFollowSurface(false)
    setAdaptive(defaultACParams)
    setParallel3d(DEFAULT_PARALLEL3D_PARAMS); setParallel3dPartId('')
    setWaterline3d(DEFAULT_WATERLINE_PARAMS); setWaterline3dPartId('')
    setAdaptive3d(DEFAULT_ADAPTIVE3D_PARAMS); setAdaptive3dPartId('')
    setAdaptive3dHeightDraft({ mode: 'current_material', topWcsMm: 0, bottomWcsMm: -5 })
    setAdaptive3dHeightAuthority('new')
    setFaceHeightDraft({ mode: 'explicit_depth', explicitTargetWcsMm: -5 })
    setFaceHeightAuthority('new')
    setFaceHeightConfirmed(false)
    setPlanarStockSmartOptIn(false)
    setFeedrateOverride(defaultFeedrateOverride(undefined, project.machine.rapidRate))
    setContourMode('cut_at_geometry')
    setUserClearedLoops(true)
    setIsPickingLoops(false)
    setBrepPickKind(null); setBrepFacePicks([]); setBrepFaceTypes({}); setBrepEdgePicks([])
    setModelEdgeChain(null); setModelEdgePicks([]); setModelEdgePickError(null); setModelEdgeMigratedIds([])
    setBrepDeriving(null); setBrepDeriveError(null); setBrepFaceDepthHint(null)
    setBrepSectionZStr(null)
    setEditLoadError(null)
    getVp()?.setLoopPickMode?.(null)
    try {
      getVp()?.setBrepPickMode?.(null)
    } finally {
      finishMachiningBoundaryPickPresentation()
    }
  }

  const handleClose = () => {
    if (isPickingLoops) {
      stopLoopPicking()
      return
    }
    closeModal()
    resetState()
  }

  // WO-2437: a machine action (an operator stop, ...) needs no tool or
  // geometry: Create adds it at the end of the setup's operation list, named
  // as typed, and selects it, so its own fields open in the Properties panel.
  const handleCreateMachineAction = (kind: MachineActionKind) => {
    if (kind === 'run_macro' && !selectedRunMacro) return
    const store = useCamStore.getState()
    const id = store.addMachineAction(setup.id, kind)
    if (opName.trim()) store.updateMachineAction(setup.id, id, { name: opName.trim() })
    if (kind === 'run_macro' && selectedRunMacro) store.updateMachineAction(setup.id, id, { macroId: selectedRunMacro.id })
    store.setActiveSetup(setup.id)
    store.setActiveOperation(id)
    closeModal()
    resetState()
    setRunMacroId('')
  }

  const handleCreate = () => {
    if (machineActionKind !== null && !isEditMode) {
      handleCreateMachineAction(machineActionKind)
      return
    }
    const commands: CamCommand[] = []
    const computeIds: string[] = []
    // WO-1544: a saved operation carries the same row overrides its preview used.
    const updateEditedOperation = (patch: Partial<Operation>) => {
      if (!editingOpPayload) return
      commands.push({ kind: 'operation.update', setupId: editingOpPayload.setupId, operationId: editingOpPayload.opId, patch: withRowHeightOverrides(withShankClearance(patch)) })
    }
    if (editLoadError) return
    if (!toolId) return
    if (!planarRoughHeightValid) return
    if (isContour && !contourHeightValid) return
    if ((isDrill || isBore) && !drillBoreHeightValid) return
    if (isThreadMill && !threadMillHeightValid) return
    if (isChamfer && !chamferHeightValid) return
    if (isEngrave && !engraveHeightValid) return
    if (isVCarve && !vcarveHeightValid) return
    if (isEditMode && editingOpPayload) {
      if (isFace) {
        updateEditedOperation({
          type: 'face',
          name: opName.trim() || tx('NewOperationModalBody.Census_Face'),
          toolId,
          geometrySelections: face.boundarySource !== 'stock' ? face.loopIds : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: face as unknown as Record<string, unknown>,
          smartHeight: buildFaceSmartHeightAuthority(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isChamfer) {
        const effectiveChamfer = chamferParamsForSave()
        updateEditedOperation({
          type: 'chamfer',
          name: opName.trim() || tx('NewOperationModalBody.Census_Chamfer'),
          toolId,
          geometrySelections: effectiveChamfer.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveChamfer as unknown as Record<string, unknown>,
          modelReferences: chamferModelReferences,
          smartHeight: chamferSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isDrill) {
        const effectiveDrill = drillParamsForSave()
        updateEditedOperation({
          type: 'drill',
          name: opName.trim() || tx('NewOperationModalBody.Drill'),
          toolId,
          geometrySelections: effectiveDrill.loopIds,
          modelReferences: drillTargetsModelReferences,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveDrill as unknown as Record<string, unknown>,
          smartHeight: drillBoreSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isBore) {
        const effectiveBore = boreParamsForSave()
        updateEditedOperation({
          type: 'bore',
          name: opName.trim() || tx('NewOperationModalBody.Bore'),
          toolId,
          geometrySelections: effectiveBore.loopIds,
          modelReferences: boreTargetModelReferences,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveBore as unknown as Record<string, unknown>,
          smartHeight: drillBoreSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage: undefined,
        })
      } else if (isThreadMill) {
        const effectiveThreadMill = threadMillParamsForSave()
        updateEditedOperation({
          type: 'thread_mill',
          name: opName.trim() || tx('NewOperationModalBody.Thread_Mill'),
          toolId,
          geometrySelections: effectiveThreadMill.loopIds,
          modelReferences: boreTargetModelReferences,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveThreadMill as unknown as Record<string, unknown>,
          smartHeight: threadMillSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isVCarve) {
        const effectiveVCarve = vcarveParamsForSave()
        syncVCarveClearingSibling(editingOpPayload.opId, effectiveVCarve, opName.trim() || 'V-carve', commands, computeIds)
        updateEditedOperation({
          type: 'vcarve',
          name: opName.trim() || 'V-carve',
          toolId,
          geometrySelections: effectiveVCarve.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveVCarve as unknown as Record<string, unknown>,
          modelReferences: vcarveModelReferences,
          smartHeight: vcarveSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isEngrave) {
        const effectiveEngrave = engraveParamsForSave()
        updateEditedOperation({
          type: 'engrave',
          name: opName.trim() || tx('NewOperationModalBody.Census_Engrave'),
          toolId,
          geometrySelections: effectiveEngrave.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveEngrave as unknown as Record<string, unknown>,
          modelReferences: engraveModelReferences,
          smartHeight: engraveSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isPocket) {
        // Radial + axial stock to leave now ride the shared PassParams fields
        // (passes.stockToLeave / passes.floorStockToLeave); the backend reads the
        // shared field first. The legacy PocketParams.floorStockToLeave is left at
        // its default for back-compat only.
        const effectivePasses: PassParams = {
          ...passes,
          finishPasses: Math.max(1, passes.finishPasses),
        }
        const effectivePocketForSave: PocketParams = pocketParamsForSave()
        updateEditedOperation({
          type: 'pocket_2d',
          name: opName.trim() || tx('NewOperationModalBody.Census_Pocket'),
          toolId,
          geometrySelections: effectivePocketForSave.loopIds,
          heights,
          passes: effectivePasses,
          linking,
          feedrateOverride,
          params: effectivePocketForSave as unknown as Record<string, unknown>,
          modelReferences: pocketModelReferences,
          smartHeight: planarSmartHeightForSave(effectivePocket.boundarySource),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isAdaptive) {
        updateEditedOperation({
          type: 'adaptive_clearing_2d',
          name: opName.trim() || tx('NewOperationModalBody.Census_Adaptive_Clearing'),
          toolId,
          geometrySelections: adaptiveForSave.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: adaptiveForSave as unknown as Record<string, unknown>,
          modelReferences: adaptiveModelReferences,
          smartHeight: planarSmartHeightForSave(effectiveAdaptive.boundarySource),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isParallel3d) {
        updateEditedOperation({
          type: 'parallel_3d',
          name: opName.trim() || tx('NewOperationModalBody.Census_3D_Finish'),
          toolId,
          geometrySelections: parallel3dPartIdEff ? [parallel3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withRestMachining(parallel3d),
          smartHeight: parallel3dSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isSteepShallow3d) {
        updateEditedOperation({
          type: 'steep_shallow_3d',
          name: opName.trim() || tx('NewOperationModalBody.Census_Steep_and_Shallow_Finish'),
          toolId,
          geometrySelections: steepShallow3dPartIdEff ? [steepShallow3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withRestMachining(steepShallow3d),
          smartHeight: buildSteepShallow3dSmartHeightAuthority(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage: undefined,
        })
      } else if (isWaterline3d) {
        updateEditedOperation({
          type: 'waterline_3d',
          name: opName.trim() || tx('NewOperationModalBody.Census_Waterline_Finish'),
          toolId,
          geometrySelections: waterline3dPartIdEff ? [waterline3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withFaceScope(waterline3d),
          smartHeight: waterline3dSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else if (isScallop3d) {
        updateEditedOperation({
          type: 'scallop_3d',
          name: opName.trim() || tx('NewOperationModalBody.Census_Scallop_Finish'),
          toolId,
          geometrySelections: scallop3dPartIdEff ? [scallop3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withRestMachining(scallop3d),
          smartHeight: buildScallop3dSmartHeightAuthority(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage: undefined,
        })
      } else if (isPencil3d) {
        updateEditedOperation({
          type: 'pencil_3d',
          name: opName.trim() || tx('NewOperationModalBody.Census_Pencil_Cleanup'),
          toolId,
          geometrySelections: pencil3dPartIdEff ? [pencil3dPartIdEff] : [],
          heights, passes, linking, feedrateOverride,
          params: withRestMachining(pencil3d),
          smartHeight: buildPencil3dSmartHeightAuthority(),
          status: 'pending', toolpathMoves: undefined, computeTimeMs: undefined, errorMessage: undefined,
        })
      } else if (isAdaptive3d) {
        const existingOperation = setup.operations.find(
          candidate => candidate.id === editingOpPayload.opId,
        )
        const validatedAuthority = existingOperation?.smartHeight === undefined
          ? undefined
          : validatePersistedSmartHeightState(existingOperation.smartHeight)
        const refreshedSmartHeight = !heightRepairRequired &&
          validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2'
          ? {
              kind: 'smart_v2' as const,
              intent: buildAdaptive3dSmartIntent({
                setupId: setup.id,
                geometryIds: adaptive3dPartIdEff ? [adaptive3dPartIdEff] : [],
                safetyIntent: operationSafetyIntent,
                mode: adaptive3dHeightDraft.mode,
                boundedBand: adaptive3dHeightDraft.mode === 'bounded_band'
                  ? adaptive3dHeightDraft
                  : undefined,
              }),
            }
          : adaptive3dHeightAuthority === 'smart_v2'
            ? {
                kind: 'smart_v2' as const,
                intent: buildAdaptive3dSmartIntent({
                  setupId: setup.id,
                  geometryIds: adaptive3dPartIdEff ? [adaptive3dPartIdEff] : [],
                  safetyIntent: operationSafetyIntent,
                  mode: adaptive3dHeightDraft.mode,
                  boundedBand: adaptive3dHeightDraft.mode === 'bounded_band'
                    ? adaptive3dHeightDraft
                    : undefined,
                }),
              }
            : existingOperation?.smartHeight
        updateEditedOperation({
          type: 'adaptive_3d',
          name: opName.trim() || tx('NewOperationModalBody.Census_3D_Rough'),
          toolId,
          geometrySelections: adaptive3dPartIdEff ? [adaptive3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: adaptive3d as unknown as Record<string, unknown>,
          smartHeight: refreshedSmartHeight,
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      } else {
        const effectivePasses: PassParams = {
          ...passes,
          stockToLeave: effStockToLeave,
          finishPasses: effFinishPasses,
          // Seam overlap has no meaning on an open chain. Keep the draft value
          // available when switching modes, but never persist it onto an open op.
          overlapMm: contourPathType === 'open' ? 0 : passes.overlapMm,
        }
        // contourFinishMode is set only for the two rough+finish modes; cleared
        // otherwise so the param matches the selected strategy exactly.
        const effectiveContour = contourParamsForSave(contourEmit.contourFinishMode)
        updateEditedOperation({
          type: 'contour_2d',
          name: opName.trim() || tx('NewOperationModalBody.Contour_2'),
          toolId,
          geometrySelections: contour.loopIds,
          heights,
          passes: effectivePasses,
          linking: contourLinkingForSave,
          feedrateOverride,
          params: effectiveContour as unknown as Record<string, unknown>,
          modelReferences: contourModelReferences,
          smartHeight: contourSmartHeightForSave(),
          status: 'pending',
          toolpathMoves: undefined,
          computeTimeMs: undefined,
          errorMessage:  undefined,
        })
      }
      computeIds.push(editingOpPayload.opId)
    } else {
      const opId = crypto.randomUUID()
      let op: Operation

      if (isFace) {
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Face', { p1: setup.operations.length + 1 }),
          type: 'face',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: face.boundarySource !== 'stock' ? face.loopIds : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: face as unknown as Record<string, unknown>,
          smartHeight: buildFaceSmartHeightAuthority(),
        }
      } else if (isChamfer) {
        const effectiveChamfer = chamferParamsForSave()
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Chamfer', { p1: setup.operations.length + 1 }),
          type: 'chamfer',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: effectiveChamfer.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveChamfer as unknown as Record<string, unknown>,
          modelReferences: chamferModelReferences,
          smartHeight: chamferSmartHeightForSave(),
        }
      } else if (isDrill) {
        const effectiveDrill = drillParamsForSave()
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Drill_2', { p1: setup.operations.length + 1 }),
          type: 'drill',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: effectiveDrill.loopIds,
          modelReferences: drillTargetsModelReferences,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveDrill as unknown as Record<string, unknown>,
          smartHeight: drillBoreSmartHeightForSave(),
        }
      } else if (isBore) {
        const effectiveBore = boreParamsForSave()
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Bore_2', { p1: setup.operations.length + 1 }),
          type: 'bore',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: effectiveBore.loopIds,
          modelReferences: boreTargetModelReferences,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveBore as unknown as Record<string, unknown>,
          smartHeight: drillBoreSmartHeightForSave(),
        }
      } else if (isThreadMill) {
        const effectiveThreadMill = threadMillParamsForSave()
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Thread_Mill_2', { p1: setup.operations.length + 1 }),
          type: 'thread_mill',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: effectiveThreadMill.loopIds,
          modelReferences: boreTargetModelReferences,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveThreadMill as unknown as Record<string, unknown>,
          smartHeight: threadMillSmartHeightForSave(),
        }
      } else if (isVCarve) {
        const effectiveVCarve = vcarveParamsForSave()
        const carveName = opName.trim() || tx('NewOperationModalBody.Census_V_carve', { p1: setup.operations.length + 1 })
        // Separate clearing tool: its own operation, listed before the carve
        // so it runs first. Self-sufficient - it carries the V-bit's angle and
        // tip and an explicit flat depth equal to the carve's effective limit.
        syncVCarveClearingSibling(opId, effectiveVCarve, carveName, commands, computeIds)
        op = {
          id: opId,
          name: carveName,
          type: 'vcarve',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: effectiveVCarve.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveVCarve as unknown as Record<string, unknown>,
          modelReferences: vcarveModelReferences,
          smartHeight: vcarveSmartHeightForSave(),
        }
      } else if (isEngrave) {
        const effectiveEngrave = engraveParamsForSave()
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Engrave', { p1: setup.operations.length + 1 }),
          type: 'engrave',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: effectiveEngrave.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: effectiveEngrave as unknown as Record<string, unknown>,
          modelReferences: engraveModelReferences,
          smartHeight: engraveSmartHeightForSave(),
        }
      } else if (isPocket) {
        // Radial + axial stock to leave ride the shared PassParams fields; the
        // legacy PocketParams.floorStockToLeave is left at its default (back-compat).
        const effectivePasses: PassParams = {
          ...passes,
          finishPasses: Math.max(1, passes.finishPasses),
        }
        const effectivePocketForSave: PocketParams = pocketParamsForSave()
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Pocket', { p1: setup.operations.length + 1 }),
          type: 'pocket_2d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: effectivePocketForSave.loopIds,
          heights,
          passes: effectivePasses,
          linking,
          feedrateOverride,
          params: effectivePocketForSave as unknown as Record<string, unknown>,
          modelReferences: pocketModelReferences,
          smartHeight: planarSmartHeightForSave(effectivePocket.boundarySource),
        }
      } else if (isAdaptive) {
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Census_Adaptive_Clearing_2', { p1: setup.operations.length + 1 }),
          type: 'adaptive_clearing_2d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: adaptiveForSave.loopIds,
          heights,
          passes,
          linking,
          feedrateOverride,
          params: adaptiveForSave as unknown as Record<string, unknown>,
          modelReferences: adaptiveModelReferences,
          smartHeight: planarSmartHeightForSave(effectiveAdaptive.boundarySource),
        }
      } else if (isParallel3d) {
        // 3D raster finish: the whole solid is the single geometrySelection; the
        // raster params ride op.params. heights/passes/linking come from the
        // shared defaults so the store's height resolution has real planes.
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Census_3D_Finish_2', { p1: setup.operations.length + 1 }),
          type: 'parallel_3d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: parallel3dPartIdEff ? [parallel3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withRestMachining(parallel3d),
          smartHeight: buildParallel3dSmartHeightAuthority(),
        }
      } else if (isWaterline3d) {
        // Waterline finish (WO-1176): the whole solid is the single
        // geometrySelection; the level params ride op.params.
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Census_Waterline_Finish_2', { p1: setup.operations.length + 1 }),
          type: 'waterline_3d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: waterline3dPartIdEff ? [waterline3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withFaceScope(waterline3d),
          smartHeight: buildWaterline3dSmartHeightAuthority(),
        }
      } else if (isSteepShallow3d) {
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Census_Steep_and_Shallow_Finish_2', { p1: setup.operations.length + 1 }),
          type: 'steep_shallow_3d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: steepShallow3dPartIdEff ? [steepShallow3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withRestMachining(steepShallow3d),
          smartHeight: buildSteepShallow3dSmartHeightAuthority(),
        }
      } else if (isScallop3d) {
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Census_Scallop_Finish_2', { p1: setup.operations.length + 1 }),
          type: 'scallop_3d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: scallop3dPartIdEff ? [scallop3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: withRestMachining(scallop3d),
          smartHeight: buildScallop3dSmartHeightAuthority(),
        }
      } else if (isPencil3d) {
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Census_Pencil_Cleanup_2', { p1: setup.operations.length + 1 }),
          type: 'pencil_3d', enabled: true, status: 'pending', toolId,
          geometrySelections: pencil3dPartIdEff ? [pencil3dPartIdEff] : [],
          heights, passes, linking, feedrateOverride,
          params: withRestMachining(pencil3d),
          smartHeight: buildPencil3dSmartHeightAuthority(),
        }
      } else if (isAdaptive3d) {
        // 3D adaptive rougher: the whole solid is the single geometrySelection;
        // the rougher params ride op.params. heights/passes/linking come from the
        // shared defaults so the store's height resolution has real planes.
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Census_3D_Rough_2', { p1: setup.operations.length + 1 }),
          type: 'adaptive_3d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: adaptive3dPartIdEff ? [adaptive3dPartIdEff] : [],
          heights,
          passes,
          linking,
          feedrateOverride,
          params: adaptive3d as unknown as Record<string, unknown>,
          smartHeight: {
            kind: 'smart_v2',
            intent: buildAdaptive3dSmartIntent({
              setupId: setup.id,
              geometryIds: adaptive3dPartIdEff ? [adaptive3dPartIdEff] : [],
              safetyIntent: operationSafetyIntent,
              mode: adaptive3dHeightDraft.mode,
              boundedBand: adaptive3dHeightDraft.mode === 'bounded_band'
                ? adaptive3dHeightDraft
                : undefined,
            }),
          },
        }
      } else {
        const effectivePasses: PassParams = {
          ...passes,
          stockToLeave: effStockToLeave,
          finishPasses: effFinishPasses,
          // Seam overlap has no meaning on an open chain. Keep the draft value
          // available when switching modes, but never persist it onto an open op.
          overlapMm: contourPathType === 'open' ? 0 : passes.overlapMm,
        }
        // contourFinishMode set only for the two rough+finish modes (see above).
        const effectiveContour = contourParamsForSave(contourEmit.contourFinishMode)
        op = {
          id: opId,
          name: opName.trim() || tx('NewOperationModalBody.Contour', { p1: setup.operations.length + 1 }),
          type: 'contour_2d',
          enabled: true,
          status: 'pending',
          toolId,
          geometrySelections: contour.loopIds,
          heights,
          passes: effectivePasses,
          linking: contourLinkingForSave,
          feedrateOverride,
          params: effectiveContour as unknown as Record<string, unknown>,
          modelReferences: contourModelReferences,
          smartHeight: contourSmartHeightForSave(),
        }
      }

      commands.push({ kind: 'operation.add', setupId: setup.id, operation: withRowHeightOverrides(withShankClearance(op)) })
      computeIds.push(opId)
    }

    const modeledSiblings = addModeledChamferSiblings(commands, computeIds)
    const result = useCamStore.getState().executeCamCommands(commands, { kind: 'operation', facts: authoringFacts, text: tx })
    if (!result.ok) return
    if (modeledSiblings) {
      // WO-3021: the passes are one after another in the setup; each computes
      // once the one before it has, so none is left out of date by the one
      // above it finishing.
      const computeSetupId = editingOpPayload?.setupId ?? setup.id
      void computeIds.reduce<Promise<void>>((previous, id) => previous.then(() => computeToolpath(computeSetupId, id)), Promise.resolve())
    } else {
      for (const id of computeIds) computeToolpath(editingOpPayload?.setupId ?? setup.id, id)
    }
    closeModal()
    resetState()
  }

  // ── Loop picking ──────────────────────────────────────────────────────────

  // Returns the pending mesh-chain derive when this pick started one, so a
  // caller (the viewport picker below) can show its own "still working" state
  // without re-running or duplicating the derive itself - it observes the
  // SAME promise the dropdown's fire-and-forget call already produces.
  const setGeoId = (id: string): Promise<void> | undefined => {
    setBrepSectionZStr(null)  // new model -> section Z default re-derives (mid-height)
    setBrepDeriveError(null)
    const selected = project.geometry.find(g => g.id === id)
    // WO-2274: a new Pocket on a sketch starts with the same explicit closed
    // loop set as All loops. Editing and model/mesh binding routes keep their
    // existing source-change behavior; an intentional clear never reselects.
    const selectSketchLoops = isPocket && !isEditMode && selected?.type === 'curves_2d'
    const initialLoopIds = selectSketchLoops
      ? (geometryForOperation(selected, opType).loops ?? []).filter(loop => loop.closed).map(loop => loop.id)
      : []
    setUserClearedLoops(initialLoopIds.length === 0)
    if (selectSketchLoops) pushPickedLoopsToViewport(initialLoopIds)
    // Every role is bound to the compound Model Item/body source. Hole and
    // face drafts clear immediately; edge chains retain their old identity
    // only long enough for the shared mismatch guard to explain the drop.
    setMachiningBoundaryFace(null)
    setMachiningBoundaryPickError(null)
    setModelDrillBinding(null)
    setModelBoreBinding(null)
    if (isFace)            setFace(f => ({ ...f, geometryId: id, loopIds: [] }))
    else if (isDrill)      setDrill(d => ({ ...d, geometryId: id, loopIds: [] }))
    else if (isBore)       setBore(b => ({ ...b, geometryId: id, loopIds: [], geometrySource: 'loop' }))
    else if (isThreadMill) setThreadMill(t => ({
      ...t, geometryId: id, loopIds: [], geometrySource: 'loop',
    }))
    else if (isPocket)     setPocket(p => ({ ...p, geometryId: id, loopIds: initialLoopIds }))
    else if (isChamfer)   setChamfer(c => ({ ...c, geometryId: id, loopIds: [], loopSides: {} }))
    else if (isEngrave)   setEngrave(e => ({ ...e, geometryId: id, loopIds: [] }))
    else if (isVCarve)    setVCarve(v => ({ ...v, geometryId: id, loopIds: [] }))
    else if (isAdaptive)  setAdaptive(a => ({ ...a, geometryId: id, loopIds: [] }))
    else {
      const nextGeo = project.geometry.find(g => g.id === id)
      setContour(c => ({
        ...c,
        // Model-body profile derivation currently produces a closed section
        // only. Never leave a hidden open mode armed when the source changes
        // from imported curves to a modeled body.
        pathType: nextGeo?.type === 'model' ? 'closed' : c.pathType,
        geometryId: id,
        loopIds: [],
      }))
    }
    if (operationAcceptsMeshEdgeChains(opType) && selected?.type === 'mesh' && selected.format === 'stl') {
      return useCamStore.getState().loadMeshEdgeChains(id).then(() => undefined).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setBrepDeriveError(message)
        useCamStore.getState().addConsoleEvent({
          severity: 'error', source: 'import', message,
          entityRef: { kind: 'geometry', id },
        })
      })
    }
    // WO-2859: choosing an STL for a drill or a bore detects its holes - the
    // same store action Detect holes runs for an STL (WO-1851) - and picks
    // them up the way Detect holes does: every hole selected, and for a drill
    // the per-hole depths the recognition measured.
    if (meshFeatureTargetAdmission(opType) === 'holes' && selected?.type === 'mesh' && selected.format === 'stl') {
      const family = opType
      return useCamStore.getState().loadMeshFeatureTargets(id).then(() => {
        const current = holeDetectTargetRef.current
        if (current.geoId !== id || current.opType !== family || current.picked > 0) return
        const landed = useCamStore.getState().project.geometry.find(g => g.id === id)
        if (!landed) return
        const forFamily = geometryForOperation(landed, family)
        const holeLoopIds = (forFamily.loops ?? []).filter(loop => loop.closed).map(loop => loop.id)
        const holes = (forFamily.layers2d ?? []).flatMap(layer => layer.holes ?? [])
        if (holeLoopIds.length === 0) return
        if (family === 'drill') {
          setDrill(d => ({ ...d, loopIds: holeLoopIds, perHoleDepth: holes.length > 0 ? true : d.perHoleDepth }))
          if (holes.length > 0) setSelectedBottom(Math.min(...holes.map(hole => hole.bottomZ)))
        } else {
          setBore(b => ({ ...b, loopIds: holeLoopIds }))
        }
        pushPickedLoopsToViewport(holeLoopIds)
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setBrepDeriveError(message)
        useCamStore.getState().addConsoleEvent({
          severity: 'error', source: 'import', message,
          entityRef: { kind: 'geometry', id },
        })
      })
    }
    return undefined
  }

  const startSourcePartPicking = () => {
    const vp = getVp()
    if (!vp?.setPartPickMode) return
    const eligibleIds = viewportPickSourceGeometries.map((geometry) => geometry.id)
    if (eligibleIds.length === 0) return
    setIsPickingSourcePart(true)
    vp.setPartPickMode((id) => {
      vp.setPartPickMode?.(null)
      if (isParallel3d) setParallel3dPartId(id)
      else if (isWaterline3d) setWaterline3dPartId(id)
      else if (isSteepShallow3d) setSteepShallow3dPartId(id)
      else if (isScallop3d) setScallop3dPartId(id)
      else if (isPencil3d) setPencil3dPartId(id)
      else if (isAdaptive3d) setAdaptive3dPartId(id)
      else {
        const pendingDerive = setGeoId(id)
        if (pendingDerive) {
          setIsDerivingPickedSourcePart(true)
          void pendingDerive.finally(() => setIsDerivingPickedSourcePart(false))
        }
      }
      useCamStore.getState().setSelectedGeometry(id)
      vp.setSelectedPart?.(id)
      setIsPickingSourcePart(false)
    }, eligibleIds)
  }

  const cancelSourcePartPicking = () => {
    getVp()?.setPartPickMode?.(null)
    setIsPickingSourcePart(false)
  }

  // WO-2859: the chain families' selection is ONE pick list - a loop id on one
  // part instance, or on every part carrying it (meshChainInstances.ts). These
  // read and write it; `loopIds` and `meshChainSources` are derived from it in
  // `withLoopSelection`, never written apart.
  const isChainFamily = isPocket || isAdaptive || isContour
  const meshChainPicks = isChainFamily
    ? ((isPocket ? pocket : isAdaptive ? adaptive : contour) as { meshChainSources?: MeshChainSources }).meshChainSources
    : undefined
  const updateLoopSelection = (next: (current: LoopSelectionPick[]) => LoopSelectionPick[]) => {
    const apply = <T extends { geometryId?: string; loopIds?: string[] }>(params: T): T =>
      withLoopSelection(params, next(loopSelectionPicks(params)))
    if (isPocket) setPocket(apply)
    else if (isAdaptive) setAdaptive(apply)
    else if (isContour) setContour(apply)
  }
  /** Replace the selection; a family without instance picks takes the ids. */
  const setLoopSelection = (picks: readonly LoopSelectionPick[]) => {
    if (isChainFamily) updateLoopSelection(() => [...picks])
    else setLoopIds([...new Set(picks.map(pick => pick.loopId))])
  }
  /** A row whose tick names its part instance: an STL edge chain under All
   *  Parts, for a family that saves chain bindings. */
  const isChainInstanceRow = (row: { loop: { id: string }; source?: { type: string; format?: string } }) =>
    isAllGeo && (isPocket || isAdaptive || isContour) && isMeshChainId(row.loop.id) &&
    !!row.source && isStlChainSource(row.source)

  const setLoopIds = (ids: string[]) => {
    if (isFace)            setFace(f => ({ ...f, loopIds: ids }))
    else if (isDrill)      setDrill(d => ({ ...d, loopIds: ids }))
    else if (isBore)       setBore(b => ({ ...b, loopIds: ids }))
    else if (isThreadMill) setThreadMill(t => ({ ...t, loopIds: ids }))
    else if (isPocket)     setPocket(p => ({ ...p, loopIds: ids }))
    else if (isChamfer)   setChamfer(c => ({ ...c, loopIds: ids }))
    else if (isEngrave)   setEngrave(e => ({ ...e, loopIds: ids }))
    else if (isVCarve)    setVCarve(v => ({ ...v, loopIds: ids }))
    else if (isAdaptive)  setAdaptive(a => ({ ...a, loopIds: ids }))
    else                  setContour(c => ({ ...c, loopIds: ids }))
  }

  const startLoopPicking = () => {
    const session = Symbol('loop-pick-session')
    activeLoopPickSessions.set(setIsPickingLoops, session)
    setIsPickingLoops(true)
    // Preserve intentional list selections when entering the workspace. A
    // legacy edited operation may still use empty loopIds as its "all" sentinel;
    // materialize those ids for the live picker so its highlight is truthful.
    const startingLoopIds = selectedLoopIds.length === 0 && !userClearedLoops
      ? closedLoops.map(loop => loop.id)
      : selectedLoopIds
    getVp()?.setPickedLoops?.(startingLoopIds)
    // The viewport can still report a loop that belongs to the selected part
    // but not to the active contour family (for example a closed profile while
    // Open contour is active). Keep a local accepted set for the lifetime of
    // this pick session so a rejected hit can immediately restore the exact
    // highlight/selection the modal owns.
    const eligibleLoopIds = new Set(closedLoops.map(loop => loop.id))
    const acceptedLoopIds = new Set(
      startingLoopIds.filter(id => eligibleLoopIds.has(id)),
    )
    // Publish the session's set so the list surfaces mutate THIS set rather
    // than leaving it behind (WO-257).
    loopPickAcceptedRef.current = acceptedLoopIds
    // Pass the current geoId so the viewport can filter clicks to the correct geometry.
    // '__all__' and null both mean "pick from any geometry".
    const allowedGeoId = (geoId && geoId !== '__all__') ? geoId : null
    getVp()?.setLoopPickMode?.((loopId, nowSelected) => {
      if (activeLoopPickSessions.get(setIsPickingLoops) !== session) return
      if (!eligibleLoopIds.has(loopId)) {
        // Wrong path family: refuse the mutation and re-synchronize the
        // viewport highlight with the modal's last accepted selection.
        getVp()?.setPickedLoops?.([...acceptedLoopIds])
        return
      }
      if (nowSelected) acceptedLoopIds.add(loopId)
      else acceptedLoopIds.delete(loopId)
      const nextLoopIds = [...acceptedLoopIds]
      setUserClearedLoops(nextLoopIds.length === 0)
      // WO-2859: a viewport click names a chain id but not which copy of the
      // STL it hit (and highlights the id on every copy), so it picks the id
      // on every part that carries it - exactly what it shows. Every other
      // pick keeps the instances it had.
      if (isChainFamily) {
        updateLoopSelection(current => nextLoopIds.flatMap((id): LoopSelectionPick[] => {
          const kept = id === loopId ? [] : current.filter(pick => pick.loopId === id)
          return kept.length > 0 ? kept : [{ loopId: id }]
        }))
      } else if (isFace) {
        setFace(prev => ({
          ...prev,
          loopIds: nextLoopIds,
        }))
      } else if (isDrill) {
        setDrill(prev => ({
          ...prev,
          loopIds: nextLoopIds,
        }))
      } else if (isBore) {
        setBore(prev => ({
          ...prev,
          geometrySource: 'loop',
          targetDiameter: undefined,
          perBoreDepth: undefined,
          loopIds: nextLoopIds,
        }))
      } else if (isThreadMill) {
        setThreadMill(prev => ({
          ...prev,
          loopIds: nextLoopIds,
        }))
      } else if (isChamfer) {
        setChamfer(prev => ({
          ...prev,
          loopIds: nextLoopIds,
        }))
      } else if (isVCarve) {
        setVCarve(prev => ({
          ...prev,
          loopIds: nextLoopIds,
        }))
      } else if (isEngrave) {
        setEngrave(prev => ({
          ...prev,
          loopIds: nextLoopIds,
        }))
      }
    }, allowedGeoId)
  }

  const stopLoopPicking = () => {
    activeLoopPickSessions.delete(setIsPickingLoops)
    loopPickAcceptedRef.current = null
    setIsPickingLoops(false)
    getVp()?.setLoopPickMode?.(null)
  }

  const clearLoopSelection = () => {
    setUserClearedLoops(true)
    setLoopSelection([])
    pushPickedLoopsToViewport([])
  }

  const selectAllLoops = () => {
    // Every row, so every copy: no per-instance binding narrows it (WO-2859).
    const allLoopIds = [...new Set(closedLoops.map(loop => loop.id))]
    setUserClearedLoops(allLoopIds.length === 0)
    setLoopSelection(allLoopIds.map(loopId => ({ loopId })))
    pushPickedLoopsToViewport(allLoopIds)
  }

  // ── Per-hole "review in viewport" (highlight one hole, then return) ────────
  // Mirrors the loop-pick banner pattern: the modal yields to a compact
  // floating banner (no backdrop, viewport visible) and highlights just the
  // clicked hole's loop amber. Back/Esc restore the op's prior picked-loops.
  const startHoleReview = (loopId: string) => {
    setSavedReviewPickedLoopIds(selectedLoopIds)
    setReviewingHoleLoopId(loopId)
    // Capture the prior camera pose ONCE (on first entry) so Back/Esc can
    // restore it. Guarded + optional-chained: in jsdom getVp() is undefined and
    // saveCameraState returns nothing, leaving the ref null (restore is a no-op).
    if (!savedReviewCameraRef.current) {
      savedReviewCameraRef.current = getVp()?.saveCameraState?.() ?? null
    }
    getVp()?.setPickedLoops?.([loopId])
    // Frame the 3D camera onto this hole (Operator's "zoom to hole"). No-op in jsdom
    // and a safe false return when the loop line is not found.
    getVp()?.focusOnLoop?.(loopId)
  }

  // ── B-rep derive flow (Stage 4) ───────────────────────────────────────────
  // Pick face / pick edges / detect holes on a 'brep' source geometry. Each
  // path calls deriveBrepLayer (store), which lands a Layer2D of standard
  // Loop2D loops; the new layer's loop IDs are then auto-selected for this op.

  const isBrepGeo     = selectedGeo?.type === 'brep'
  // Model sources share the section UI, while face identity remains a live
  // Model-kernel binding rather than a landed B-rep layer.
  const isModelSectionGeo = selectedGeo?.type === 'model'
  // Does the project hold any 3D model? Stock-source pockets avoid that model's
  // standing bosses automatically, so the "Auto from 3D model" badge is honest
  // only when a brep is present. Flat (curves_2d-only) parts: stock is just a
  // rectangle, nothing inferred -> no badge.
  const hasBrepGeometry = project.geometry.some(g => g.type === 'brep')
  const isContourOp   = !isPocket && !isDrill && !isBore && !isThreadMill && !isChamfer && !isFace && !isEngrave && !isVCarve && !isAdaptive && !isParallel3d && !isWaterline3d && !isSteepShallow3d && !isScallop3d && !isPencil3d && !isAdaptive3d
  const showPickFace  = isPocket || isAdaptive || isFace || isContourOp || isDrill || isBore || isThreadMill
  const showPickEdges = isContourOp || isEngrave || isVCarve || isChamfer || isThreadMill
  // Section-at-Z produces closed material cross-section loops — useful to the
  // same region-consuming ops as Pick face (pocket/adaptive boundaries, face
  // outline, contour profiles). Drill accepts face picks but never sections.
  const showSectionZ  = showPickFace && !isDrill
  // The shared capability map keeps model Section-at-Z limited to profile
  // families that actually consume its loops.
  const modelBindingCapability = MODEL_BODY_BINDING_CAPABILITIES[opType]
  const modelProfileComputeSupported =
    modelBindingCapability.computeSupported && modelBindingCapability.mode === 'profile'
  // WO-1924: the modeled-body edge pick is gated by the edge-chain capability
  // itself (Contour, Pocket, Adaptive Clearing on a geometry boundary), not by
  // showPickEdges, which governs the imported B-rep edge pick.
  const modelEdgeChainBoundaryOk =
    !(isPocket && pocket.boundarySource === 'stock') &&
    !(isAdaptive && adaptive.boundarySource === 'stock')
  const canPickModelEdges =
    isModelSectionGeo && !isAllGeo && modelEdgeChainBoundaryOk && modelBodyEdgePickOffered(opType, getVp())
  // Hide the derive block unless the selected source/op has a real action.
  const showBrepDeriveBlock = !isAllGeo && (
    (isBrepGeo && (showPickFace || showPickEdges || isDrill)) ||
    canPickModelEdges ||
    (isModelSectionGeo && isDrill) ||
    (isModelSectionGeo && (isBore || isThreadMill)) ||
    (isBrepGeo && showSectionZ) ||
    (isModelSectionGeo && modelProfileComputeSupported && showSectionZ)
  )

  // A picked machining-boundary face is offered only for a modeled-body
  // source whose shared capability is a supported profile binding.
  const canPickMachiningBoundaryFace =
    isModelSectionGeo && !isAllGeo && modelProfileComputeSupported
    && (!isAdaptive || adaptive.boundarySource !== 'stock')

  const canPickModelBoreWall =
    isModelSectionGeo && !isAllGeo && (isBore || isThreadMill) &&
    modelBindingCapability.computeSupported && modelBindingCapability.mode === 'cylinder-targets'

  // Q-92: a modeled-face hit already names its owning body, so a model-source
  // pick resolves its OWN geometry from the hit instead of trusting whatever
  // body happened to be preselected. Returns a named refusal (never a stale
  // fallback) when the hit cannot be resolved to a geometry this workflow is
  // allowed to bind to. `mode` names the shared capability the resolved body
  // must actually support for this operation type.
  const resolveModelFaceOwner = (
    sel: { geoId: string; index: number; isModelFace?: boolean },
    mode: 'profile' | 'cylinder-targets',
    what: string,
  ): { geo: NonNullable<typeof selectedGeo>; bodyId: string; faceStableId: string; modelItemId: string } | { error: string } => {
    if (!sel.isModelFace) return { error: tx('NewOperationModalBody.That_was_not_a_modeled_body_face_pick', { p1: what }) }
    if (!sel.geoId) return { get error() { return tx('NewOperationModalBody.The_picked_face_reported_no_owning_body_re_sync') } }
    const owner = project.geometry.find(g => g.id === sel.geoId)
    if (!owner) return { error: tx('NewOperationModalBody.The_picked_face_belongs_to_a_body_that_is_2', { p1: geometryNameForId(sel.geoId) }) }
    if (!isModelOpSourceEligible(owner)) {
      return { error: tx('NewOperationModalBody.cannot_be_the_source_of_this_operation_pick_a', { p1: owner.name }) }
    }
    if (!modelBindingCapability.computeSupported || modelBindingCapability.mode !== mode) {
      return { error: tx('NewOperationModalBody.does_not_support_for_this_operation_type', { p1: owner.name, p2: what }) }
    }
    // WO-355: resolve the OWNING Model Item HERE, at the boundary that can
    // fail, instead of letting an unresolved id ride into readModelBodyFaceFacts/
    // recognizeModelBodyHoles, where a silent LEGACY_MODEL_ITEM_ID default would
    // read the wrong (or no) document and misreport it as "no 3D model to read".
    // isModelOpSourceEligible is deliberately a SEPARATE predicate from the one
    // resolveOwningModelItemId keys on (modelOrigin.ts), kept free to narrow on
    // its own in a later stage - so this is a genuine second check, not a
    // restatement of the one above, and is the seam that catches the day they
    // diverge instead of silently substituting legacy.
    const modelItemId = resolveOwningModelItemId(owner)
    if (modelItemId === undefined) {
      return { error: tx('NewOperationModalBody.Could_not_determine_which_Model_Item_owns_re_sync', { p1: owner.name }) }
    }
    const faceStableId = owner.modelBody?.display?.faceIds?.[sel.index]
    const bodyId = owner.modelBody?.ref.bodyId
    if (!faceStableId || !bodyId) {
      return { get error() { return tx('NewOperationModalBody.Could_not_resolve_the_picked_face_identity_re_sync') } }
    }
    return { geo: owner, bodyId, faceStableId, modelItemId }
  }

  const startModelBoreFacePick = () => {
    if (!geoId || !selectedGeo || !canPickModelBoreWall) return
    const vp = getVp()
    if (!vp?.setBrepPickMode) {
      setBrepDeriveError(tx('NewOperationModalBody.The_viewport_face_picker_is_unavailable'))
      return
    }
    setBrepDeriveError(null)
    setBrepPickKind('model-bore')
    setIsModelBorePickResolving(false)
    // Q-92: arming a face pick turns whole-body selection OFF entirely.
    const suspensionToken = useCamStore.getState().beginFacePickBodySelection(vp)
    const presentationToken = startMachiningBoundaryPickPresentation(vp, geoId)
    const finishPick = (error: string | null) => {
      if (!isCurrentMachiningBoundaryPick(presentationToken)) return
      try {
        vp.setBrepPickMode?.(null)
      } finally {
        finishMachiningBoundaryPickPresentation(presentationToken)
        useCamStore.getState().endFacePickBodySelection(suspensionToken, vp)
        setBrepDeriveError(error)
        setBrepPickKind(null)
        setIsModelBorePickResolving(false)
      }
    }
    // Scoped to this one arm session (a fresh binding every call, captured by
    // the picker callback below) rather than a ref - once this session ends,
    // finishPick disarms vp.setBrepPickMode entirely and no further clicks
    // can reach the callback that reads it.
    let resolving = false
    try {
      // Q-92: no allowedGeoId - a bore wall may be picked on ANY eligible
      // modeled body, and the hit names the body it belongs to.
      vp.setBrepPickMode('face', (sel) => {
        if (!isCurrentMachiningBoundaryPick(presentationToken)) return
        // A click landing while the previous pick's kernel-mount/face-facts
        // round trip is still in flight must never start a second one - the
        // FIRST pick always wins, so a later click can never overwrite it
        // with a stale refusal (WO-335 audit, same shape as SetupModal's
        // bore pick: the round trip is long enough for a second click to
        // land before the first one returns).
        if (resolving) return
        const owner = resolveModelFaceOwner(
          sel, 'cylinder-targets',
          isThreadMill ? tx('NewOperationModalBody.a_hole_or_boss_wall_on_a_modeled_body') : tx('NewOperationModalBody.an_internal_cylindrical_wall_on_a_modeled_body'),
        )
        if ('error' in owner) {
          finishPick(owner.error)
          return
        }
        const { geo, bodyId, faceStableId, modelItemId } = owner
        resolving = true
        setIsModelBorePickResolving(true)
        // WO-365: an ordinary browser refresh (or a session that never
        // visited the Model tab this load) leaves this item's document
        // un-hydrated in memory even though a durable checkpoint for it is
        // sitting right there - self-heal it here, the same recovery
        // SetupModal's bore pick already does (WO-362), before asking the
        // headless replay for a document it would otherwise wrongly report
        // as never having existed.
        void ensureDocumentArchiveHydrated(
          project.id, modelItemId, project.modelItems?.find((m) => m.id === modelItemId),
        ).then(() => readModelBodyFaceFacts(bodyId, faceStableId, modelItemId)).then(({ snapshot, verdicts }) => {
          if (!isCurrentMachiningBoundaryPick(presentationToken)) return
          if (isThreadMill) {
            // WO-1942: a hole threads internally, a boss externally; size
            // and length snap from the picked cylinder, as the B-rep pick does.
            const target = deriveModelThreadMillTarget(
              geo, project.modelItemPlacements ?? [], faceStableId, snapshot, verdicts,
            )
            const c = target.cylinder
            const kind: ThreadMillParams['threadKind'] = c.kind === 'bore' ? 'internal' : 'external'
            const snap = c.kind === 'bore' ? findThreadByBore(c.diameter) : findThreadByMajor(c.diameter)
            setModelBoreBinding({
              modelItemId, bodyId, faceStableId,
              derived: { loop: target.loop, cylinder: c },
            })
            setThreadMill(prev => ({
              ...prev,
              geometryId: geo.id,
              threadKind: kind,
              externalReference: 'top',
              majorDiameter: snap ? snap.majorDiameter : (kind === 'external' ? c.diameter : prev.majorDiameter),
              pitch: snap ? snap.pitch : prev.pitch,
              tpi: snap ? snap.tpi : undefined,
              threadDepth: parseFloat(Math.max(0.5, c.topZ - c.bottomZ).toFixed(3)),
              heightReference: 'geometry_face',
              loopIds: [target.loop.id],
              geometrySource: 'cylinder',
            }))
            setOpHeightReference('geometry_face')
            useCamStore.getState().retargetFacePickBodySelection(geo.id)
            finishPick(null)
            return
          }
          const result = deriveModelBodyBoreTarget(
            geo, project.modelItemPlacements ?? [], faceStableId, snapshot, verdicts,
          )
          setModelBoreBinding({
            modelItemId,
            bodyId,
            faceStableId,
            derived: { loop: result.loop, cylinder: result.cylinder },
          })
          setBore(prev => ({
            ...prev,
            // The face's own owning geometry is the source, not the body that
            // happened to be selected before the pick armed.
            geometryId: geo.id,
            loopIds: [result.loop.id],
            geometrySource: 'cylinder',
            perBoreDepth: prev.perBoreDepth ?? true,
            heightReference: heights.bottomManual === true ? prev.heightReference : 'geometry_face',
          }))
          if (heights.bottomManual !== true) {
            setOpHeightReference('geometry_face')
            setSelectedBottom(result.localBottomZ, { bottomManual: false })
          }
          // Exit re-selects the body the bore wall belongs to (see above).
          useCamStore.getState().retargetFacePickBodySelection(geo.id)
          finishPick(null)
        }).catch((err: unknown) => {
          finishPick(err instanceof Error ? err.message : String(err))
        })
      }, null)
    } catch (err) {
      finishPick(err instanceof Error ? err.message : String(err))
    }
  }

  const startMachiningBoundaryFacePick = () => {
    if (!geoId || !selectedGeo || !canPickMachiningBoundaryFace) return
    const vp = getVp()
    if (!vp?.setBrepPickMode) {
      setMachiningBoundaryPickError(tx('NewOperationModalBody.The_viewport_face_picker_is_unavailable'))
      return
    }
    setMachiningBoundaryPickError(null)
    setMachiningBoundaryPickActive(true)
    // Collapse the modal to the floating pick banner (same mechanism the
    // brep face/edge/datum picks already use) so the viewport is actually
    // clickable - the modal's own centered dialog otherwise covers it.
    setBrepPickKind('machining-boundary')
    // Q-92: arming a face pick turns whole-body selection OFF entirely, so the
    // face hover/pick tint is never competing with an orange body fill and no
    // preselected body is left standing as an identity to fall back on.
    const suspensionToken = useCamStore.getState().beginFacePickBodySelection(vp)
    const presentationToken = startMachiningBoundaryPickPresentation(vp, geoId)
    const finishPick = (error: string | null) => {
      if (!isCurrentMachiningBoundaryPick(presentationToken)) return
      try {
        vp.setBrepPickMode?.(null)
      } finally {
        finishMachiningBoundaryPickPresentation(presentationToken)
        useCamStore.getState().endFacePickBodySelection(suspensionToken, vp)
        setMachiningBoundaryPickError(error)
        setMachiningBoundaryPickActive(false)
        setBrepPickKind(null)
      }
    }

    try {
      // Q-92: no allowedGeoId. The boundary face IS the operation's source
      // choice - clicking a face on any eligible modeled body selects that
      // body, so the operator never has to select the body first.
      vp.setBrepPickMode('face', (sel) => {
        if (!isCurrentMachiningBoundaryPick(presentationToken)) return
        // CAM-BINDING Stage 5 / Q-92: only a model-pick hit that resolves to an
        // eligible modeled body yields a real face - a stray occt-model brep
        // hit, an unloaded body, or a body this op type cannot bind is refused
        // by name, never silently accepted as a wrong-kernel identity.
        const owner = resolveModelFaceOwner(sel, 'profile', tx('NewOperationModalBody.a_face_on_a_modeled_body'))
        if ('error' in owner) {
          finishPick(owner.error)
          return
        }
        const { geo, bodyId, faceStableId, modelItemId } = owner
        try {
          // Validate the pick IMMEDIATELY (fail loud at pick time, mirrors the
          // STEP Pick Face precedent) - nothing is written to the store until
          // Save; this call is pure geometry validation only.
          deriveModelBodyFace(geo, faceStableId, project.modelItemPlacements ?? [])
        } catch (err) {
          finishPick(err instanceof Error ? err.message : String(err))
          return
        }
        // The face's own owning body is the operation's source. setGeoId is a
        // no-op-shaped rewrite when the pick landed on the already-selected
        // body, and a real source change when it did not.
        if (geo.id !== geoId) setGeoId(geo.id)
        setMachiningBoundaryFace({
          modelItemId,
          bodyId,
          faceStableId,
        })
        // Leaving face-pick mode re-selects the body the operator actually
        // picked on, not whichever body was selected before arming.
        useCamStore.getState().retargetFacePickBodySelection(geo.id)
        finishPick(null)
      }, null)
    } catch (err) {
      finishPick(err instanceof Error ? err.message : String(err))
    }
  }

  const cancelMachiningBoundaryFacePick = () => {
    try {
      getVp()?.setBrepPickMode?.(null)
    } finally {
      finishMachiningBoundaryPickPresentation()
      useCamStore.getState().endFacePickBodySelection(null, getVp())
      setMachiningBoundaryPickActive(false)
      setBrepPickKind(null)
    }
  }

  // Model rows stay identity; their real world pose comes from Placement.
  // Section-Z therefore presents world Z. Same frame resolution
  // deriveModelBodySection itself calls, so the range shown is the range the
  // derive accepts - never a second, drifting opinion about the body's pose.
  const modelSectionFrame = (() => {
    if (!isModelSectionGeo || !selectedGeo) return null
    const itemId = selectedGeo.modelItemId ?? LEGACY_MODEL_ITEM_ID
    const bodyId = selectedGeo.modelBody?.ref.bodyId
    try {
      return resolveModelReferenceFrame(project.modelItemPlacements ?? [], itemId, bodyId)
    } catch {
      return null
    }
  })()
  // A pure Z-preserving rotation never moves a point's Z, so translation-only
  // is exact for an upright body (mirrors deriveModelBodySection's own
  // localZ = worldZ - position.z). A tilted or flipped body shows the placed
  // body's own world Z range, the range its section derive accepts.
  const modelSectionWorldZOffset = modelSectionFrame?.position.z ?? 0
  const modelSectionPlacedZRange = modelSectionFrame && selectedGeo && isTiltedOffZ(modelSectionFrame.rotation)
    ? modelBodyWorldZRange(selectedGeo, modelSectionFrame)
    : null

  // B-rep bounds are model-local; Model bounds are shifted into world Z.
  const brepZMin = !selectedGeo ? 0
    : isBrepGeo ? selectedGeo.boundingBox.min.z
    : isModelSectionGeo ? modelSectionPlacedZRange?.min ?? selectedGeo.boundingBox.min.z + modelSectionWorldZOffset
    : 0
  const brepZMax = !selectedGeo ? 0
    : isBrepGeo ? selectedGeo.boundingBox.max.z
    : isModelSectionGeo ? modelSectionPlacedZRange?.max ?? selectedGeo.boundingBox.max.z + modelSectionWorldZOffset
    : 0
  // Keep section values in the source's expected frame; format only at the UI edge.
  const fmtZ = (vMm: number) => fmtDim(vMm, displayUnits)
  // Effective section Z (mm): typed display value parsed to mm if parseable,
  // else mid-height; always clamped to the model's Z range.
  const brepSectionZ = (() => {
    const mid = (brepZMin + brepZMax) / 2
    const typed = brepSectionZStr !== null ? parseDimToMm(brepSectionZStr, displayUnits) : NaN
    const z = Number.isFinite(typed) ? typed : mid
    return parseFloat(Math.min(brepZMax, Math.max(brepZMin, z)).toFixed(3))
  })()

  // Non-face derives; face flow remains multi-pick below.
  const runBrepDerive = async (
    kind: 'edges' | 'holes' | 'section',
    args?: { edgeIndices?: number[]; z?: number },
  ) => {
    if (!geoId || isAllGeo) return
    setBrepDeriving(kind)
    setBrepDeriveError(null)
    setBrepFaceDepthHint(null)
    try {
      // Snapshot the layer count so only newly derived layers are selected.
      const geoBefore = useCamStore.getState().project.geometry.find(g => g.id === geoId)
      const oldLen = geoBefore?.layers2d?.length ?? 0
      await deriveBrepLayer(geoId, kind, args)
      const geo = useCamStore.getState().project.geometry.find(g => g.id === geoId)
      if (!geo) return
      const newLayers = (geo.layers2d ?? []).slice(oldLen)
      if (newLayers.length === 0) return
      // Select the union of every newly landed layer.
      const newLayerIds = new Set(newLayers.map(l => l.id))
      const layerLoopIds = (geo.loops ?? []).filter(l => newLayerIds.has(l.layerId)).map(l => l.id)
      setLoopIds(layerLoopIds)
      pushPickedLoopsToViewport(layerLoopIds)
      if (kind === 'holes') {
        // Holes lands exactly one layer; read its hole table.
        const layer = newLayers[0]
        if (layer.holes && layer.holes.length > 0) {
          // The deepest detected bottom is the op fallback; per-hole facts win.
          const minBottomZ = Math.min(...layer.holes.map(hf => hf.bottomZ))
          setSelectedBottom(minBottomZ)
          setDrill(d => ({ ...d, perHoleDepth: true }))
        }
        // Bind Model face ids so compute can re-derive live hole truth.
        if (isModelSectionGeo && selectedGeo?.modelBody?.ref.bodyId) {
          try {
            const bodyId = selectedGeo.modelBody.ref.bodyId
            const modelItemId = resolveOwningModelItemId(selectedGeo) ?? LEGACY_MODEL_ITEM_ID
            // WO-365: same reachability gap as the bore-wall pick above -
            // self-heal an un-hydrated-this-page-load document before asking
            // the headless replay to read it.
            await ensureDocumentArchiveHydrated(
              project.id, modelItemId, project.modelItems?.find((m) => m.id === modelItemId),
            )
            const verdicts = await recognizeModelBodyHoles(bodyId, modelItemId)
            const derived = deriveModelBodyDrillTargets(
              selectedGeo,
              project.modelItemPlacements ?? [],
              verdicts,
            )
            const stableIds = Array.from(new Set(derived.targets.flatMap((t) => t.faceIds)))
            if (stableIds.length === 0) {
              // Recognizer produced holes but no ElementMap face ids - still
              // usable as a landed snapshot, just without durable rebinding.
              setModelDrillBinding(null)
            } else {
              setModelDrillBinding({
                modelItemId,
                bodyId,
                stableIds,
              })
            }
          } catch {
            setModelDrillBinding(null)
          }
        } else {
          setModelDrillBinding(null)
        }
      } else if (kind === 'edges') {
        // A picked edge binds the fallback bottom to the deepest picked plane.
        const edgeZs = newLayers
          .map(l => l.projectionPlane?.origin.z)
          .filter((z): z is number => z !== undefined)
        if (edgeZs.length > 0) {
          const minZ = Math.min(...edgeZs)
          setSelectedBottom(minZ)
        }
      }
    } catch (err) {
      setBrepDeriveError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrepDeriving(null)
    }
  }

  // Viewport Z scrub previews read-only, then lands the confirmed section.
  const startSectionScrub = () => {
    if (!geoId || isAllGeo || !selectedGeo) return
    // Model sources use typed Z; the live occt-model preview is B-rep-only.
    if (isModelSectionGeo) return
    // Z-plane sections refuse tilted imported models.
    if (selectedGeo.rotation.x !== 0 || selectedGeo.rotation.y !== 0) {
      setBrepDeriveError(
        tx('NewOperationModalBody.is_rotated_off_the_Z_axis_rotation_X_deg', { p1: selectedGeo.name, p2: selectedGeo.rotation.x })
        + tx('NewOperationModalBody.Y_deg_so_a_Z_plane_section_cannot_be', { p1: selectedGeo.rotation.y })
        + tx('NewOperationModalBody.Reset_rotation_X_Y_to_0_or_re_import'))
      return
    }
    const vp = getVp()
    if (!vp?.enterBrepSectionMode) return
    setBrepDeriveError(null)
    const gid = geoId
    const entered = vp.enterBrepSectionMode(
      gid,
      brepSectionZ,
      (z) => deriveSection(gid, z).then(r => r.loops),
      (z) => {
        setIsScrubbingSectionZ(false)
        setBrepSectionZStr(fmtZ(z))
        void runBrepDerive('section', { z })
      },
      () => setIsScrubbingSectionZ(false),
    )
    if (entered) setIsScrubbingSectionZ(true)
    else setBrepDeriveError(tx('NewOperationModalBody.Could_not_enter_the_viewport_section_mode_for_this'))
  }

  // Each face lands one layer; selection is their union and the deepest face
  // supplies the geometry-local smart bottom.
  const runBrepFaceDerives = async (faceIndices: number[]) => {
    if (!geoId || isAllGeo || faceIndices.length === 0) return
    setBrepDeriving('face')
    setBrepDeriveError(null)
    setBrepFaceDepthHint(null)
    try {
      const allLoopIds: string[] = []
      const faceZs: number[] = []
      for (const faceIndex of faceIndices) {
        await deriveBrepLayer(geoId, 'face', { faceIndex })
        // Each derive appends its layer last (appendGeometryProjection).
        const geo = useCamStore.getState().project.geometry.find(g => g.id === geoId)
        const layer = geo?.layers2d?.[geo.layers2d.length - 1]
        if (!geo || !layer) continue
        for (const l of (geo.loops ?? []).filter(l => l.layerId === layer.id)) {
          if (!allLoopIds.includes(l.id)) allLoopIds.push(l.id)
        }
        if (layer.projectionPlane) faceZs.push(layer.projectionPlane.origin.z)
      }
      setLoopIds(allLoopIds)
      // A planar face giving a flat circle is the MANUAL/loop path for thread
      // milling (no bore-vs-boss inference) -> mark geometrySource 'loop'.
      if (isThreadMill) setThreadMill(t => ({ ...t, geometrySource: 'loop' }))
      if (isBore) setBore(b => ({ ...b, geometrySource: 'loop', targetDiameter: undefined, perBoreDepth: undefined }))
      pushPickedLoopsToViewport(allLoopIds)
      if (faceZs.length > 0) {
        const minZ = Math.min(...faceZs)
        // UNIFORM RULE (R2a-REVISED): a picked planar face is the BOTTOM of cut
        // (the floor you machine down to) for EVERY op that accepts one - pocket,
        // contour, adaptive, face_2d, chamfer/engrave/drill alike. Multi-pick
        // binds to the DEEPEST (min Z) face.
        setSelectedBottom(minZ)
        if (!faceZs.every(z => Math.abs(z - minZ) < 1e-6)) {
          setBrepFaceDepthHint(
            tx('NewOperationModalBody.Picked_faces_have_multiple_depths_bottom_of_cut_bound', { p1: fmtZ(minZ) }))
        }
      }
    } catch (err) {
      setBrepDeriveError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrepDeriving(null)
    }
  }

  // Q-92: every brep face/edge pick session suspends whole-body selection for
  // its lifetime. Unlike the model-body picks these stay SOURCE-BOUND: the
  // picked indices are per-geometry subshape ids and the derive lands a layer
  // on the source itself, so a face on a different body could not be honoured
  // without silently rewriting geometry the operator did not choose.
  // This component holds no hooks (BK-178-DECOMP), so the session token cannot
  // ride a ref across renders. It does not need to: only one pick session in
  // this modal is ever live, and the token-less end ends whichever that is.
  const beginBrepPickSuspension = () => {
    useCamStore.getState().beginFacePickBodySelection(getVp())
  }
  const endBrepPickSuspension = () => {
    useCamStore.getState().endFacePickBodySelection(null, getVp())
  }

  // Face pick accumulates like the edge flow: every click toggles a face in or
  // out of the selection; Done derives all picked faces at once.
  const startBrepFacePick = () => {
    if (!geoId || isAllGeo) return
    setBrepDeriveError(null)
    setBrepFaceDepthHint(null)
    setBrepFacePicks([])
    setBrepFaceTypes({})
    setBrepPickKind('face')
    getVp()?.setPickedBrepSelections?.([])
    beginBrepPickSuspension()
    getVp()?.setBrepPickMode?.('face', (sel, nowSelected) => {
      // The raycast is scoped to geoId, so a foreign hit is a broken
      // invariant, not a source change - refuse it by name rather than
      // deriving one body's face index against another body's shape.
      if (sel.geoId !== geoId) {
        setBrepDeriveError(tx('NewOperationModalBody.That_face_belongs_to_a_different_body_than_this', { p1: geometryNameForId(sel.geoId) }))
        return
      }
      setBrepFacePicks(prev => nowSelected
        ? (prev.includes(sel.index) ? prev : [...prev, sel.index])
        : prev.filter(i => i !== sel.index))
      setBrepFaceTypes(prev => ({ ...prev, [sel.index]: sel.surfaceType }))
    }, geoId)
  }

  const finishBrepFacePick = () => {
    // Route using the real OCCT surface type; Drill refuses planar picks.
    const picks = brepFacePicks
    const allCylinders = picks.length > 0 && picks.every(i => brepFaceTypes[i] === 1)
    getVp()?.setBrepPickMode?.(null)
    endBrepPickSuspension()
    setBrepPickKind(null)
    setBrepFacePicks([])
    setBrepFaceTypes({})
    if (picks.length === 0) return
    if (allCylinders) {
      if (isThreadMill) void runThreadCylinderDerive(picks)
      else if (isBore || isDrill) void runHoleCylinderDerive(picks)
      else void runCylinderLoopDerive(picks)
    } else if (isDrill) setBrepDeriveError(
      tx('NewOperationModalBody.Census_Drill_selected_face_is_not_a_cylindrical_hole_wall'))
    else void runBrepFaceDerives(picks)
  }

  // Cylinder pick for a region/profile op (pocket / adaptive_clearing / face /
  // contour): derive the wall(s) as loop geometry via the SAME deriveBrepLayer
  // 'cylinder' call thread milling uses, then route each cylinder through
  // consumeCylinder (the shipped operationGeometry matrix = the semantic source
  // of truth). For a boundary-inference op a BOSS becomes an avoid-ISLAND
  // (loopType 'hole' -> pocket2d classifyLoops) while a BORE stays a 'contour'
  // boundary; the derived rim loop's type is flipped to match. When the matrix
  // returns heightRole 'floor' (pocket / adaptive / face AND contour / vcarve --
  // every op that profiles or clears a boss/bore descends to its base), the cut
  // BOTTOM binds to the DEEPEST wall base (min cylinder bottomZ) using the SAME
  // bottomHeightMode='selected_face' + selectedFaceZ (model Z) the picked-PLANAR-
  // face path (Part A) uses, so dispatch's selectedFaceWorldZ re-resolves it
  // correctly (adds position.z for a moved STEP part; verbatim otherwise).
  const runCylinderLoopDerive = async (faceIndices: number[]) => {
    if (!geoId || isAllGeo || faceIndices.length === 0) return
    setBrepDeriving('face')
    setBrepDeriveError(null)
    setBrepFaceDepthHint(null)
    try {
      await deriveBrepLayer(geoId, 'cylinder', { faceIndices })
      // The derive appended its layer last (appendGeometryProjection).
      const geo = useCamStore.getState().project.geometry.find(g => g.id === geoId)
      const layer = geo?.layers2d?.[geo.layers2d.length - 1]
      if (!geo || !layer) return
      const cylinders = layer.cylinders ?? []
      if (cylinders.length === 0) return  // store throws on no cylinders; nothing to derive
      // Every loop on the appended layer (one CCW top-rim circle per cylinder).
      const rimLoopIds = (geo.loops ?? []).filter(l => l.layerId === layer.id).map(l => l.id)
      // Route every wall through the matrix; collect island type-flips + floor Zs.
      const typeFlips: Record<string, Loop2D['type']> = {}
      const floorZs: number[] = []
      for (const c of cylinders) {
        const res = consumeCylinder(opType, {
          geoId, kind: c.kind, diameter: c.diameter, topZ: c.topZ, bottomZ: c.bottomZ,
        })
        if (c.loopId && res.loopType) typeFlips[c.loopId] = res.loopType
        if (res.heightRole === 'floor') floorZs.push(c.bottomZ)
      }
      if (Object.keys(typeFlips).length > 0) useCamStore.getState().setLoopTypes(geoId, typeFlips)
      setLoopIds(rimLoopIds)
      pushPickedLoopsToViewport(rimLoopIds)
      // Bottom of cut = the DEEPEST wall base (min bottomZ), stored in the SAME
      // frame the planar-face path stores (model Z; selectedFaceWorldZ re-resolves
      // per source at dispatch). The planeOrderingError dispatch guard fails loud
      // on any top<=bottom inversion, so no extra guard is needed here.
      if (floorZs.length > 0) {
        const minZ = Math.min(...floorZs)
        setSelectedBottom(minZ, {
          // AUTO binding (not a manual override): let recompute re-resolve the
          // cylinder floor. Explicit false so a prior manual flag is cleared.
          bottomManual: false,
        })
        if (!floorZs.every(z => Math.abs(z - minZ) < 1e-6)) {
          setBrepFaceDepthHint(
            tx('NewOperationModalBody.Picked_walls_have_multiple_depths_bottom_of_cut_bound', { p1: fmtZ(minZ) }))
        }
      }
    } catch (err) {
      setBrepDeriveError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrepDeriving(null)
    }
  }

  // Drill and Bore share the same internal-wall geometry and per-target depth facts.
  const runHoleCylinderDerive = async (faceIndices: number[]) => {
    if (!geoId || isAllGeo || faceIndices.length === 0) return
    setBrepDeriving('face')
    setBrepDeriveError(null)
    setBrepFaceDepthHint(null)
    try {
      await deriveBrepLayer(geoId, 'cylinder', { faceIndices })
      const geo = useCamStore.getState().project.geometry.find(g => g.id === geoId)
      const layer = geo?.layers2d?.[geo.layers2d.length - 1]
      if (!geo || !layer) return
      const cylinders = layer.cylinders ?? []
      const opLabel = isDrill ? tx('NewOperationModalBody.Drill') : tx('NewOperationModalBody.Bore')
      if (cylinders.some(c => c.kind !== 'bore')) {
        throw new Error(tx('NewOperationModalBody.selected_cylinder_is_an_external_boss_Pick_an_internal', { p1: opLabel }))
      }
      const bores = cylinders.filter(c => c.kind === 'bore')
      if (bores.length === 0) {
        throw new Error(tx('NewOperationModalBody.no_internal_cylindrical_hole_walls_were_found_on_this', { p1: opLabel }))
      }
      const rimLoopIds = bores.map(c => c.loopId).filter((id): id is string => !!id)
      const minBottomZ = Math.min(...bores.map(c => c.bottomZ))
      if (isDrill) {
        setDrill(prev => ({ ...prev, geometryId: geoId, loopIds: rimLoopIds,
          perHoleDepth: true,
          heightReference: heights.bottomManual === true ? prev.heightReference : 'geometry_face' }))
      } else {
        setBore(prev => ({ ...prev, geometryId: geoId, loopIds: rimLoopIds,
          geometrySource: 'cylinder', perBoreDepth: prev.perBoreDepth ?? true,
          heightReference: heights.bottomManual === true ? prev.heightReference : 'geometry_face' }))
      }
      if (heights.bottomManual !== true) {
        setOpHeightReference('geometry_face')
        setSelectedBottom(minBottomZ, { bottomManual: false })
      }
      pushPickedLoopsToViewport(rimLoopIds)
    } catch (err) {
      setBrepDeriveError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrepDeriving(null)
    }
  }

  // Derive a cylinder layer from the picked cylindrical face(s) and INFER the
  // thread spec: bore -> internal (snap by tap-drill), boss -> external (snap by
  // major OD); threadDepth = cylinder length. Multi-pick: infer kind/size/depth
  // from the FIRST cylinder, but select ALL rim loops. deriveBrepLayer throws
  // (fail-loud) on a non-vertical-cylinder face; caught into brepDeriveError.
  const runThreadCylinderDerive = async (faceIndices: number[]) => {
    if (!geoId || isAllGeo || faceIndices.length === 0) return
    setBrepDeriving('face')
    setBrepDeriveError(null)
    setBrepFaceDepthHint(null)
    try {
      await deriveBrepLayer(geoId, 'cylinder', { faceIndices })
      // The derive appended its layer last (appendGeometryProjection).
      const geo = useCamStore.getState().project.geometry.find(g => g.id === geoId)
      const layer = geo?.layers2d?.[geo.layers2d.length - 1]
      if (!geo || !layer) return
      const cylinders = layer.cylinders ?? []
      if (cylinders.length === 0) return  // store throws on no cylinders; nothing to infer
      // Rim loop ids: every loop on the appended layer (same collection runBrep-
      // FaceDerives uses). One CCW top-rim circle was generated per cylinder.
      const rimLoopIds = (geo.loops ?? []).filter(l => l.layerId === layer.id).map(l => l.id)
      const c = cylinders[0]
      const kind: ThreadMillParams['threadKind'] = c.kind === 'bore' ? 'internal' : 'external'
      const snap = c.kind === 'bore' ? findThreadByBore(c.diameter) : findThreadByMajor(c.diameter)
      const cylLen = Math.max(0.5, c.topZ - c.bottomZ)
      const round3 = (v: number) => parseFloat(v.toFixed(3))
      setThreadMill(prev => ({
        ...prev,
        threadKind: kind,
        externalReference: 'top',
        majorDiameter: snap ? snap.majorDiameter : (kind === 'external' ? c.diameter : prev.majorDiameter),
        pitch: snap ? snap.pitch : prev.pitch,
        tpi: snap ? snap.tpi : undefined,
        threadDepth: round3(cylLen),
        heightReference: 'geometry_face',
        loopIds: rimLoopIds,
        geometrySource: 'cylinder',
      }))
      // Keep the shared height-reference state consistent with the heights tab.
      setOpHeightReference('geometry_face')
      pushPickedLoopsToViewport(rimLoopIds)
    } catch (err) {
      setBrepDeriveError(err instanceof Error ? err.message : String(err))
    } finally {
      setBrepDeriving(null)
    }
  }

  const startBrepEdgePick = () => {
    if (!geoId || isAllGeo) return
    setBrepDeriveError(null)
    setBrepEdgePicks([])
    setBrepPickKind('edge')
    getVp()?.setPickedBrepSelections?.([])
    beginBrepPickSuspension()
    getVp()?.setBrepPickMode?.('edge', (sel, nowSelected) => {
      if (sel.geoId !== geoId) {
        setBrepDeriveError(tx('NewOperationModalBody.That_edge_belongs_to_a_different_body_than_this', { p1: geometryNameForId(sel.geoId) }))
        return
      }
      setBrepEdgePicks(prev => nowSelected
        ? (prev.includes(sel.index) ? prev : [...prev, sel.index])
        : prev.filter(i => i !== sel.index))
    }, geoId)
  }

  const finishBrepEdgePick = () => {
    getVp()?.setBrepPickMode?.(null)
    endBrepPickSuspension()
    setBrepPickKind(null)
    const picks = brepEdgePicks
    setBrepEdgePicks([])
    if (picks.length > 0) void runBrepDerive('edges', { edgeIndices: picks })
  }

  type ModelEdgeSelection = { geoId: string; kind: 'face' | 'edge'; index: number; isModelEdge?: boolean }

  const startModelEdgePick = () => {
    if (!geoId || !selectedGeo || !canPickModelEdges) return
    const vp = getVp()
    if (!vp?.setBrepPickMode) {
      setModelEdgePickError(tx('NewOperationModalBody.The_viewport_edge_picker_is_unavailable'))
      return
    }
    setModelEdgePickError(null)
    setModelEdgeMigratedIds([])
    setModelEdgePicks([])
    setBrepPickKind('model-edge')
    beginBrepPickSuspension()
    vp.setBrepPickMode('edge', (rawSel, nowSelected) => {
      const sel = rawSel as ModelEdgeSelection
      if (sel.isModelEdge !== true) {
        setModelEdgePickError(tx('NewOperationModalBody.That_was_not_a_modeled_body_edge_pick_an'))
        return
      }
      if (sel.geoId !== geoId) {
        setModelEdgePickError(
          tx('NewOperationModalBody.That_edge_belongs_to_a_different_body_than_this_2', { p1: geometryNameForId(sel.geoId) }) +
          tx('NewOperationModalBody.Change_Source_geometry_first'),
        )
        return
      }
      const edgeStableId = selectedGeo.modelBody?.display?.edgeIds?.[sel.index]
      if (!edgeStableId) {
        setModelEdgePickError(
          tx('NewOperationModalBody.Could_not_resolve_the_picked_edge_identity_re_sync'),
        )
        return
      }
      setModelEdgePickError(null)
      setModelEdgePicks(prev => nowSelected
        ? (prev.includes(edgeStableId) ? prev : [...prev, edgeStableId])
        : prev.filter(id => id !== edgeStableId))
    }, geoId)
  }

  const finishModelEdgePick = () => {
    getVp()?.setBrepPickMode?.(null)
    endBrepPickSuspension()
    setBrepPickKind(null)
    const picks = modelEdgePicks
    setModelEdgePicks([])
    if (picks.length === 0) return
    const bodyId = selectedGeo?.modelBody?.ref.bodyId
    if (!selectedGeo || !bodyId) {
      setModelEdgePickError(tx('NewOperationModalBody.This_body_has_no_identity_yet_re_sync_open'))
      return
    }
    try {
      const derived = deriveModelBodyEdges(
        selectedGeo, picks, project.modelItemPlacements ?? [], modelEdgeChainDeriveOptions(opType),
      )
      setModelEdgeChain({ modelItemId: selectedGeo.modelItemId, bodyId, edgeStableIds: picks })
      setModelEdgeMigratedIds(derived.migratedEdgeIds)
      setModelEdgePickError(null)
      setLoopIds([])
    } catch (err) {
      setModelEdgePickError(err instanceof Error ? err.message : String(err))
    }
  }

  const cancelModelEdgePick = () => {
    getVp()?.setBrepPickMode?.(null)
    endBrepPickSuspension()
    setBrepPickKind(null)
    setModelEdgePicks([])
  }

  const clearModelEdgeChain = () => {
    setModelEdgeChain(null)
    setModelEdgeMigratedIds([])
    setModelEdgePickError(null)
  }

  const cancelBrepPick = () => {
    getVp()?.setBrepPickMode?.(null)
    setBrepPickKind(null)
    setBrepFacePicks([])
    setBrepFaceTypes({})
    setBrepEdgePicks([])
    setModelEdgePicks([])
    if (brepPickKind === 'model-bore') finishMachiningBoundaryPickPresentation()
    // Q-92: every cancel path restores ordinary whole-body selection, whichever
    // pick kind (face / edge / datum / model-bore) owned the canvas.
    endBrepPickSuspension()
  }


  // ── Loop-picking floating banner ──────────────────────────────────────────
  if (isPickingSourcePart) {
    return (
      <div className="loop-pick-banner" data-testid="op-source-part-pick-banner">
        <MousePointer2 size={16} className="loop-pick-icon" />
        <span className="loop-pick-text">{tx('NewOperationModalBody.Click_the_source_part_in_the_viewport_Hovered_eligible')}</span>
        <button
          className="loop-pick-done-btn"
          data-testid="op-source-part-pick-cancel"
          onClick={cancelSourcePartPicking}
        >
          <X size={14} />{tx('NewOperationModalBody.Cancel')}</button>
      </div>
    )
  }

  const loopPickBanner = isPickingLoops ? (
    <div className="loop-pick-banner" data-testid="op-loop-pick-banner">
      <MousePointer2 size={16} className="loop-pick-icon" />
      <span className="loop-pick-text">{tx('NewOperationModalBody.Click_highlighted_loops_in_the_viewport_to_select_or')}<strong>{tx('NewOperationModalBody.loop_selected', { p1: selectedLoopIds.length, p2: selectedLoopIds.length !== 1 ? tx('NewOperationModalBody.Census_s') : '' })}</strong>
      </span>
      <button
        className="loop-pick-done-btn"
        data-testid="op-loop-pick-clear"
        disabled={selectedLoopIds.length === 0 && userClearedLoops}
        onClick={clearLoopSelection}
      >
        <X size={14} />{tx('NewOperationModalBody.Clear_selection')}</button>
      <button className="loop-pick-done-btn" onClick={stopLoopPicking}>
        <CheckCircle2 size={14} />{tx('NewOperationModalBody.Done')}</button>
    </div>
  ) : null

  // ── B-rep face/edge picking floating banner ───────────────────────────────
  if (brepPickKind) {
    return (
      <div className="loop-pick-banner">
        {brepPickKind === 'model-bore' && isModelBorePickResolving
          ? <Loader2 size={16} className="loop-pick-icon wcs-snap-picking-icon" />
          : <MousePointer2 size={16} className="loop-pick-icon" />}
        <span className="loop-pick-text" data-testid={brepPickKind === 'model-bore' ? 'model-bore-pick-status' : undefined}>
          {brepPickKind === 'face' ? (
            <>{tx(`facePick.${opType}`)}
              <strong>{tx('NewOperationModalBody.face_selected', { p1: brepFacePicks.length, p2: brepFacePicks.length !== 1 ? tx('NewOperationModalBody.Census_s') : '' })}</strong></>
          ) : brepPickKind === 'edge' ? (
            <>{tx('NewOperationModalBody.Click_model_edges_to_select_or_deselect_them')}<strong>{tx('NewOperationModalBody.edge_selected', { p1: brepEdgePicks.length, p2: brepEdgePicks.length !== 1 ? tx('NewOperationModalBody.Census_s') : '' })}</strong></>
          ) : brepPickKind === 'machining-boundary' ? (
            <>{tx('NewOperationModalBody.Click_a_flat_face_on_the_model_to_use')}{machiningBoundaryPickError && <strong style={{ color: '#ff8c8c' }}> {readableInternalIds(machiningBoundaryPickError)}</strong>}</>
          ) : brepPickKind === 'face-target' ? (
            <>{tx('NewOperationModalBody.Click_the_FLAT_model_face_that_the_Face_operation')}{brepDeriveError && <strong style={{ color: '#ff8c8c' }}> {readableInternalIds(brepDeriveError)}</strong>}</>
          ) : brepPickKind === 'model-edge' ? (
            <>{tx('NewOperationModalBody.Click_edges_on_the_model_to_build_this_operation')}<strong data-testid="model-edge-pick-count">{tx('NewOperationModalBody.edge_selected', { p1: modelEdgePicks.length, p2: modelEdgePicks.length !== 1 ? tx('NewOperationModalBody.Census_s') : '' })}</strong>
              {modelEdgePickError && <strong style={{ color: '#ff8c8c' }} data-testid="model-edge-pick-banner-error"> {readableInternalIds(modelEdgePickError)}</strong>}</>
          ) : brepPickKind === 'model-bore' ? (isModelBorePickResolving
            ? <>{tx('NewOperationModalBody.Reading_the_picked_face_hold_on')}</>
            : <>{isThreadMill ? tx('NewOperationModalBody.Click_one_hole_or_boss_wall_to_thread') : tx('NewOperationModalBody.Click_one_internal_cylindrical_wall_to_use_as_this')}{brepDeriveError && <strong style={{ color: '#ff8c8c' }}> {readableInternalIds(brepDeriveError)}</strong>}</>
          ) : (
            <>{tx('NewOperationModalBody.Click_a_FLAT_face_to_use_as_the_datum')}{brepDeriveError && <strong style={{ color: '#ff8c8c' }}> {readableInternalIds(brepDeriveError)}</strong>}</>
          )}
        </span>
        {brepPickKind === 'face' && (
          <button className="loop-pick-done-btn" data-testid="brep-faces-done" onClick={finishBrepFacePick}>
            <CheckCircle2 size={14} />{tx('NewOperationModalBody.Done')}</button>
        )}
        {brepPickKind === 'edge' && (
          <button className="loop-pick-done-btn" data-testid="brep-edges-done" onClick={finishBrepEdgePick}>
            <CheckCircle2 size={14} />{tx('NewOperationModalBody.Done')}</button>
        )}
        {brepPickKind === 'model-edge' && (
          <button className="loop-pick-done-btn" data-testid="model-edges-done" onClick={finishModelEdgePick}>
            <CheckCircle2 size={14} />{tx('NewOperationModalBody.Done')}</button>
        )}
        <button
          className="loop-pick-done-btn"
          data-testid="brep-pick-cancel"
          onClick={brepPickKind === 'machining-boundary'
            ? cancelMachiningBoundaryFacePick
            : brepPickKind === 'model-edge' ? cancelModelEdgePick : cancelBrepPick}
        >
          <X size={14} />{tx('NewOperationModalBody.Cancel')}</button>
      </div>
    )
  }

  // ── Per-hole review floating banner ───────────────────────────────────────
  // The clicked hole's loop is highlighted amber in the viewport; the modal
  // yields to this compact banner (no backdrop -> viewport visible) so the user
  // can SEE which hole it is, then click Back (or press Esc) to return with all
  // form state intact (the modal never unmounted). Same banner pattern as the
  // loop-pick banner above.
  if (reviewingHoleLoopId) {
    const reviewIndex = drillHoleRows.find(r => r.id === reviewingHoleLoopId)?.index
    return (
      <div className="loop-pick-banner op-perhole-review-banner" data-testid="drill-perhole-review-banner">
        <MousePointer2 size={16} className="loop-pick-icon" />
        <span className="loop-pick-text">{tx('NewOperationModalBody.Reviewing_hole')}<strong>{tx('NewOperationModalBody.symbol')}{reviewIndex ?? '?'}</strong>{tx('NewOperationModalBody.highlighted_in_the_viewport_Click_Back_when_done')}<span className="op-perhole-review-esc">{tx('NewOperationModalBody.Esc')}</span>{tx('NewOperationModalBody.symbol_2')}</span>
        <button className="loop-pick-done-btn" data-testid="drill-perhole-review-back" onClick={stopHoleReview}>
          <X size={14} />{tx('NewOperationModalBody.Back_to_operation')}</button>
      </div>
    )
  }

  // ── Section-at-Z viewport scrub: modal fully yields to the viewport ───────
  // The slice/section overlay carries its own Z input + Confirm/Cancel, so
  // (unlike the pick banners) there is nothing left for the modal to show.
  if (isScrubbingSectionZ) return null

  // ADR-0003 (no silent fallbacks): if edit-prefill hit an operation type with
  // no editor, render an explicit error state instead of the Contour-shaped UI.
  // The Save button stays disabled; the only escape is Cancel (handleClose ->
  // resetState clears editLoadError).
  if (editLoadError) {
    return (
      // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
      // GOVERNED scrim in the UI-70 census (this is the editLoadError early-
      // return authoring site; the ordinary create/edit render below is the
      // second site).
      <div className="modal-backdrop" data-ui78-sanctioned="" onMouseDown={handleClose}>
        <div className="modal-container op-modal" onMouseDown={e => e.stopPropagation()} ref={dialogFocusRef}>
          <div className="modal-header">
            <TriangleRight size={15} className="modal-header-icon" />
            <span className="modal-title">{tx('NewOperationModalBody.Edit_Operation', { p1: setup.name })}</span>
            <button className="modal-close-btn" onClick={handleClose}><X size={14} /></button>
          </div>
          <div className="modal-body op-modal-body">
            <div className="op-tab-content" data-testid="op-edit-load-error">
              <span className="op-hint op-hint-warn" style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, display: 'block' }}>{tx('NewOperationModalBody.Cannot_edit_this_operation', { p1: readableInternalIds(editLoadError) })}</span>
            </div>
          </div>
          <div className="modal-footer">
            <button className="modal-btn modal-btn-ghost" onClick={handleClose}>{tx('NewOperationModalBody.Cancel_2')}</button>
            <button className="modal-btn modal-btn-primary" data-testid="op-create" disabled>
              {tx('NewOperationModalBody.Save_Recompute')}
            </button>
          </div>
        </div>
      </div>
    )
  }
  // ── Full modal render ──────────────────────────────────────────────────────
  return (
    <>
    <OperationModalInteractionGuard
      isPickingLoops={isPickingLoops}
      onStopPicking={stopLoopPicking}
      pickerContextKey={loopPickerContextKey}
      canCreate={canCreate}
      onCreate={handleCreate}
      onClose={handleClose}
    />
    {/* CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- the
        ordinary create/edit render's own MODAL-GOVERNED scrim (the second
        authoring site; the editLoadError early return above is the first). */}

    <div
      className="modal-backdrop"
      data-testid="op-modal-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={handleClose}
    >
      <div
        className="modal-container op-modal"
        data-testid="op-modal-panel"
        data-presentation={isPickingLoops ? 'floating-configuration' : 'modal'}
        onMouseDown={event => event.stopPropagation()}
        ref={dialogFocusRef}
      >

        {/* Header */}
        <div
          className="modal-header"
          style={isPickingLoops ? { cursor: 'move', touchAction: 'none', userSelect: 'none' } : undefined}
        >
          <TriangleRight size={15} className="modal-header-icon" />
          <span className="modal-title">{isEditMode ? tx('NewOperationModalBody.Edit_Operation_2') : tx('NewOperationModalBody.New_Operation')}{tx('NewOperationModalBody.symbol_3')}{setup.name}</span>
          <button className="modal-close-btn" onClick={handleClose}><X size={14} /></button>
        </div>
        {/* Tab bar */}
        <div className="op-modal-tabs">
          {/* parallel_3d does its own path linking (lead-ins/retracts) and reads
              no op.linking, so the Linking tab does nothing for it — drop it.
              thread_mill likewise derives its entry motion from handedness /
              cut-direction and params.leadInOut and never reads op.linking. */}
          {TABS.filter(t => !((isParallel3d || isWaterline3d || isSteepShallow3d || isScallop3d || isPencil3d || isAdaptive3d || isVCarve || isThreadMill) && t.id === 'linking'))
            .filter(t => machineActionKind === null || t.id === 'type').map(t => (
            <button
              key={t.id}
              className={`op-modal-tab ${tab === t.id ? 'op-modal-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}<span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="modal-body op-modal-body">

          {/* ── Type & Name ───────────────────────────────────────────────── */}
          {tab === 'type' && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Operation_type')}</p>
              <div className="op-type-grid">
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'contour_2d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('contour_2d')}
                >
                  <TriangleRight size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.2D_Contour')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'pocket_2d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('pocket_2d')}
                >
                  <Circle size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.2D_Pocket')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'drill' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('drill')}
                >
                  <ArrowDown size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Drill')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'bore' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('bore')}
                >
                  <Circle size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Bore')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'chamfer' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('chamfer')}
                >
                  <Scissors size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.2D_Chamfer')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'face' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('face')}
                >
                  <Square size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.2D_Face')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'engrave' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('engrave')}
                >
                  <PenTool size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Engrave_Trace')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'vcarve' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('vcarve')}
                  data-testid="op-type-vcarve"
                >
                  <TriangleRight size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.V_Carve')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'adaptive_clearing_2d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('adaptive_clearing_2d')}
                >
                  <Spline size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.2D_Adaptive_Clearing')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'thread_mill' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('thread_mill')}
                >
                  <Tornado size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Thread_Mill')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'parallel_3d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('parallel_3d')}
                >
                  <Layers size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Parallel_Finish_3D')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'waterline_3d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('waterline_3d')}
                  data-testid="op-type-waterline3d"
                >
                  <Waves size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Waterline_Finish_3D')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'scallop_3d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('scallop_3d')}
                  data-testid="op-type-scallop3d"
                >
                  <Circle size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Scallop_Finish_3D')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'pencil_3d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('pencil_3d')}
                  data-testid="op-type-pencil3d"
                >
                  <PenTool size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Pencil_Cleanup_3D')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'steep_shallow_3d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('steep_shallow_3d')}
                  data-testid="op-type-steep-shallow3d"
                >
                  <Gauge size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Steep_and_Shallow_3D')}</span>
                </div>
                <div
                  className={`op-type-card ${machineActionKind === null && opType === 'adaptive_3d' ? 'op-type-card-active' : ''}`}
                  onClick={() => selectOperationType('adaptive_3d')}
                >
                  <Waypoints size={24} />
                  <span className="op-type-name">{tx('NewOperationModalBody.Adaptive_Rough_3D')}</span>
                </div>
              </div>

              {!isEditMode && (
                <>
                  <p className="op-section-label" style={{ marginTop: 18 }}>Machine actions</p>
                  <div className="op-type-grid" data-testid="op-machine-actions">
                    {MACHINE_ACTION_TYPES.map(({ kind, label }) => (
                      <div
                        key={kind}
                        className={`op-type-card ${machineActionKind === kind ? 'op-type-card-active' : ''}`}
                        data-testid={`op-type-action-${kind}`}
                        onClick={() => { setMachineActionKind(kind); setTab('type') }}
                      >
                        <Hand size={24} />
                        <span className="op-type-name">{label}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {machineActionKind === 'run_macro' && (
                <div className="mform-group">
                  <label className="mform-label" htmlFor="run-macro-create-select">Macro</label>
                  <select
                    id="run-macro-create-select"
                    className="mform-input"
                    data-testid="run-macro-create-select"
                    value={selectedRunMacro?.id ?? ''}
                    onChange={(event) => setRunMacroId(event.target.value)}
                  >
                    <option value="">Choose a macro</option>
                    {callableMacros.map((macro) => <option key={macro.id} value={macro.id}>{macro.name} (M{macro.mCode})</option>)}
                  </select>
                  <p>Only shown macros with program-callable M-codes are listed. M6 also changes tools.</p>
                  {callableMacros.length === 0 && <p>This machine has no callable macros.</p>}
                </div>
              )}
              <p className="op-section-label" style={{ marginTop: 18 }}>{tx('NewOperationModalBody.Operation_name')}</p>
              <input
                className="mform-input"
                style={{ fontSize: 14 }}
                placeholder={machineActionKind !== null
                  ? machineActionLabel(machineActionKind)
                  : isDrill
                  ? tx('NewOperationModalBody.Drill_2', { p1: setup.operations.length + 1 })
                  : isBore
                  ? tx('NewOperationModalBody.Bore_2', { p1: setup.operations.length + 1 })
                  : isThreadMill
                  ? tx('NewOperationModalBody.Thread_Mill_2', { p1: setup.operations.length + 1 })
                  : isPocket
                    ? tx('NewOperationModalBody.Pocket', { p1: setup.operations.length + 1 })
                    : isChamfer
                      ? tx('NewOperationModalBody.Chamfer', { p1: setup.operations.length + 1 })
                      : isFace
                        ? tx('NewOperationModalBody.Face', { p1: setup.operations.length + 1 })
                        : isEngrave
                          ? tx('NewOperationModalBody.Engrave', { p1: setup.operations.length + 1 })
                        : isVCarve
                          ? tx('NewOperationModalBody.Census_V_carve', { p1: setup.operations.length + 1 })
                          : tx('NewOperationModalBody.Contour', { p1: setup.operations.length + 1 })}
                value={opName}
                onChange={e => setOpName(e.target.value)}
              />
            </div>
          )}

          {/* ── Tool ─────────────────────────────────────────────────────── */}
          {tab === 'tool' && (() => {
            // OP-TOOL-FILTER: filter bar for the flat tool list (Operator's ask,
            // annotated screenshot retained with OP-TOOL-FILTER evidence)
            // -- text search, a "used in project" speed
            // toggle, and a library facet (this project DOES have a
            // multi-library concept -- src/types/index.ts ToolLibrary +
            // Tool.libraryId, edited via ToolLibraryModal -- so per Operator's
            // recon instruction this is the library facet, not a type
            // facet). Filters compose (AND). Same for both the New and Edit
            // Operation paths -- this is the ONE tab === 'tool' block both
            // share.

            // Tools referenced by ANY operation across the WHOLE project
            // (every setup, not just the active one) -- the speed path Operator
            // named ("for speed tools already used in the project").
            const usedToolIds = new Set(
              project.setups.flatMap(s => s.operations.map(o => o.toolId)).filter((id): id is string => !!id)
            )

            // Text-search matching: same substring/case-insensitive idiom as
            // ToolLibraryModal's search (name / T# / type), extended to also
            // match diameter (both raw and unit-formatted) per Operator's explicit
            // "filters by name/diameter/type text" -- this wizard's rows lead
            // with diameter, unlike the Tool Library's list.
            const q = toolFilterSearch.trim().toLowerCase()
            const matchesSearch = (tool: typeof toolLibrary[number]) => {
              if (!q) return true
              const name    = (tool.name ?? '').toLowerCase()
              const tnum    = tool.toolNumber !== undefined ? `t${tool.toolNumber}` : ''
              const tType   = (tool.type ?? '').replace(/_/g, ' ').toLowerCase()
              const diamRaw = tool.diameter != null ? String(tool.diameter).toLowerCase() : ''
              const diamFmt = tool.diameter != null ? fmtDim(tool.diameter, displayUnits).toLowerCase() : ''
              return name.includes(q) || tnum.includes(q) || tType.includes(q)
                || diamRaw.includes(q) || diamFmt.includes(q)
            }

            const filtersActive = q !== '' || toolFilterUsedOnly || toolFilterLibraryId !== 'all'
            const filteredTools = toolLibrary
              .filter(tool => toolFilterLibraryId === 'all' || tool.libraryId === toolFilterLibraryId)
              .filter(tool => !toolFilterUsedOnly || usedToolIds.has(tool.id))
              .filter(matchesSearch)

            const clearToolFilters = () => {
              setToolFilterSearch('')
              setToolFilterUsedOnly(false)
              setToolFilterLibraryId('all')
            }

            return (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Select_tool_from_library')}</p>
              {toolLibrary.length === 0 ? (
                <div className="op-no-tool-notice">
                  <Wrench size={28} />
                  <span className="op-no-tool-title">{tx('NewOperationModalBody.No_tools_in_library')}</span>
                  <span className="op-no-tool-body">{tx('NewOperationModalBody.Open_the')}<strong>{tx('NewOperationModalBody.Tool_Library')}</strong>{tx('NewOperationModalBody.from_the_toolbar_to_add_tools_then_return_here')}</span>
                </div>
              ) : (
                <>
                  <div className="tool-list-controls op-tool-filter-bar" data-testid="op-tool-filter-bar">
                    <input
                      className="tool-list-search"
                      type="text"
                      placeholder={tx('NewOperationModalBody.Search_name_diameter_type')}
                      value={toolFilterSearch}
                      onChange={(e) => setToolFilterSearch(e.target.value)}
                      data-testid="op-tool-filter-search"
                    />
                    <div className="tool-list-control-row">
                      <select
                        className="tool-list-select"
                        value={toolFilterLibraryId}
                        onChange={(e) => setToolFilterLibraryId(e.target.value)}
                        data-tooltip={tx('NewOperationModalBody.Filter_by_tool_library')}
                        data-testid="op-tool-filter-library"
                      >
                        <option value="all">{tx('NewOperationModalBody.All_libraries')}</option>
                        {toolLibraries.map(lib => (
                          <option key={lib.id} value={lib.id}>{lib.name}</option>
                        ))}
                      </select>
                      {filtersActive && (
                        <button className="tool-list-clear" onClick={clearToolFilters} data-tooltip={tx('NewOperationModalBody.Clear_search_and_filters')}>{tx('NewOperationModalBody.Clear')}</button>
                      )}
                    </div>
                    <div className="op-toggle-row">
                      <button
                        type="button"
                        className={`op-toggle-btn ${toolFilterUsedOnly ? 'op-toggle-active' : ''}`}
                        onClick={() => setToolFilterUsedOnly(v => !v)}
                        data-testid="op-tool-filter-used-toggle"
                        data-tooltip={tx('NewOperationModalBody.Show_only_tools_already_used_by_an_operation_somewhere')}
                      >{tx('NewOperationModalBody.Used_in_project', { p1: usedToolIds.size > 0 ? ` (${usedToolIds.size})` : '' })}</button>
                    </div>
                    {filtersActive && (
                      <div className="tool-list-count">{tx('NewOperationModalBody.of_tools', { p1: filteredTools.length, p2: toolLibrary.length })}</div>
                    )}
                  </div>
                  {filteredTools.length === 0 ? (
                    <div className="op-no-tool-notice" data-testid="op-tool-filter-empty">
                      <Wrench size={28} />
                      <span className="op-no-tool-title">{tx('NewOperationModalBody.No_tools_match_your_filters')}</span>
                      <span className="op-no-tool-body">{tx('NewOperationModalBody.Try_clearing_the_search_the_used_in_project_toggle')}</span>
                    </div>
                  ) : (
                    <div className="op-tool-list">
                      {filteredTools.map(tool => (
                        <div
                          key={tool.id}
                          className={`op-tool-row ${toolId === tool.id ? 'op-tool-row-active' : ''}`}
                          onClick={() => setToolId(tool.id)}
                        >
                          <div className="op-tool-swatch" style={{
                            background:
                              tool.type === 'flat_end_mill' ? '#4a90d9' :
                              tool.type === 'ball_end_mill' ? '#9b59b6' :
                              tool.type === 'v_bit'         ? '#e67e22' : '#27ae60',
                          }} />
                          <div className="op-tool-info">
                            <span className="op-tool-name">{tool.name}</span>
                            <span className="op-tool-meta">{tx('NewOperationModalBody.flutes_FL', { p1: tool.diameter != null ? fmtDim(tool.diameter, displayUnits) : '?', p2: unitLabel(displayUnits), p3: tool.numberOfFlutes ?? '?', p4: tool.fluteLength != null ? fmtDim(tool.fluteLength, displayUnits) : '?', p5: unitLabel(displayUnits), p6: (tool.type ?? '').replace(/_/g, ' ') })}</span>
                            {tool.feedsAndSpeeds?.default?.rpm != null && (
                              <span className="op-tool-feeds">{tx('NewOperationModalBody.RPM', { p1: tool.feedsAndSpeeds.default.rpm.toLocaleString(), p2: fmtFeed(tool.feedsAndSpeeds.default.feedRate ?? 0, displayUnits), p3: feedLabel(displayUnits) })}</span>
                            )}
                          </div>
                          {tool.toolNumber !== undefined && (
                            <span className="op-tool-num">{tx('NewOperationModalBody.T', { p1: tool.toolNumber })}</span>
                          )}
                          {toolId === tool.id && (
                            <CheckCircle2 size={16} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            )
          })()}

          {/* ── Geometry (Face: boundary source) ─────────────────────────── */}
          {tab === 'geometry' && isFace && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Boundary_source')}</p>
              <div className="op-toggle-row" style={{ marginBottom: 10 }}>
                <button
                  className={`op-toggle-btn ${face.boundarySource === 'stock' ? 'op-toggle-active' : ''}`}
                  onClick={() => setFace(f => ({ ...f, boundarySource: 'stock' }))}
                >{tx('NewOperationModalBody.Stock')}</button>
                <button
                  className={`op-toggle-btn ${face.boundarySource === 'geometry' ? 'op-toggle-active' : ''}`}
                  onClick={() => setFace(f => ({ ...f, boundarySource: 'geometry', geometryId: '', loopIds: [] }))}
                >{tx('NewOperationModalBody.Contour_2')}</button>
                <button
                  className={`op-toggle-btn ${face.boundarySource === 'rest' ? 'op-toggle-active' : ''}`}
                  data-testid="face-rest-boundary"
                  onClick={() => setFace(f => ({ ...f, boundarySource: 'rest' }))}
                  data-tooltip={tx('NewOperationModalBody.Face_only_what_earlier_pocket_operations_left_behind')}
                >{tx('NewOperationModalBody.Rest')}</button>
              </div>
              {face.boundarySource === 'stock' ? (
                <div className="op-pass-summary">
                  <span>{tx('NewOperationModalBody.Faces_the_active_stock_s_top_footprint_fixed_or')}</span>
                </div>
              ) : null}
              {face.boundarySource === 'rest' ? (
                <div className="op-pass-summary">
                  <span>{tx('NewOperationModalBody.Faces_what_is_left_after_the_earlier_operations_this')}</span>
                </div>
              ) : null}
            </div>
          )}

          {/* ── Geometry (Pocket: boundary source) ───────────────────────── */}
          {tab === 'geometry' && isPocket && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Boundary_source')}</p>
              <div className="op-toggle-row" style={{ marginBottom: 10 }}>
                <button
                  className={`op-toggle-btn ${pocket.boundarySource === 'stock' ? 'op-toggle-active' : ''}`}
                  data-testid="pocket-stock-smart-height"
                  onClick={() => {
                    setHeightRepairMessage(null)
                    setPlanarStockSmartOptIn(true)
                    setPlanarGeometrySmartOptIn(false)
                    setPocket(current => ({
                      ...current,
                      boundarySource: 'stock',
                      geometryId: '',
                      loopIds: [],
                      heightReference: 'stock_top',
                      planeOffset: 0,
                    }))
                  }}
                >{tx('NewOperationModalBody.Stock')}</button>
                <button
                  className={`op-toggle-btn ${pocket.boundarySource !== 'stock' ? 'op-toggle-active' : ''}`}
                  data-testid="pocket-geometry-smart-height"
                  onClick={() => {
                    setHeightRepairMessage(null)
                    setPlanarStockSmartOptIn(false)
                    setPlanarGeometrySmartOptIn(true)
                    setPocketReferenceAndIntent('geometry_face', 0, { boundarySource: 'geometry' })
                  }}
                >{tx('NewOperationModalBody.Selected_geometry')}</button>
              </div>
              {pocket.boundarySource === 'stock' ? (
                <>
                  {hasBrepGeometry && (
                    <AutoFromModelBadge
                      note={tx('NewOperationModalBody.Complete_assigned_STEP_target_note')}
                      onClear={() => {
                        setPlanarStockSmartOptIn(false)
                        setPlanarGeometrySmartOptIn(true)
                        setPocketReferenceAndIntent('geometry_face', 0, { boundarySource: 'geometry' })
                      }}
                    />
                  )}
                  <div className="op-pass-summary" data-testid="pocket-stock-smart-height-preview">
                    <LiveSmartHeightPlan
                      preview={planarRoughHeightPreview}
                      idleMessage={SMART_HEIGHT_V2_REPAIR_MESSAGE}
                      repairMessage={heightRepairMessage}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="op-pass-summary" data-testid="pocket-geometry-smart-height-preview">
                    <LiveSmartHeightPlan
                      preview={planarRoughHeightPreview}
                      idleMessage={tx('NewOperationModalBody.Select_one_geometry_and_loop_to_resolve_its', { p1: planarRoughGeometryTargetLabel })}
                      repairMessage={heightRepairMessage}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'geometry' && isAdaptive && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Boundary_source')}</p>
              <div className="op-toggle-row" style={{ marginBottom: 10 }}>
                <button
                  className={`op-toggle-btn ${adaptive.boundarySource === 'stock' ? 'op-toggle-active' : ''}`}
                  data-testid="adaptive-stock-smart-height"
                  onClick={() => {
                    setHeightRepairMessage(null)
                    setPlanarStockSmartOptIn(true)
                    setPlanarGeometrySmartOptIn(false)
                    setMachiningBoundaryFace(null)
                    setMachiningBoundaryPickError(null)
                    setAdaptive(current => ({
                      ...current,
                      boundarySource: 'stock',
                      geometryId: '',
                      loopIds: [],
                      heightReference: 'stock_top',
                      planeOffset: 0,
                    }))
                  }}
                >{tx('NewOperationModalBody.Stock')}</button>
                <button
                  className={`op-toggle-btn ${adaptive.boundarySource !== 'stock' ? 'op-toggle-active' : ''}`}
                  data-testid="adaptive-geometry-smart-height"
                  onClick={() => {
                    setHeightRepairMessage(null)
                    setPlanarStockSmartOptIn(false)
                    setPlanarGeometrySmartOptIn(true)
                    setAdaptiveReferenceAndIntent('geometry_face', 0, { boundarySource: 'geometry' })
                  }}
                >{tx('NewOperationModalBody.Selected_geometry')}</button>
              </div>
              {adaptive.boundarySource === 'stock' ? (
                <>
                  {hasBrepGeometry && (
                    <AutoFromModelBadge
                      note={tx('NewOperationModalBody.Complete_assigned_STEP_target_note')}
                      onClear={() => {
                        setPlanarStockSmartOptIn(false)
                        setPlanarGeometrySmartOptIn(true)
                        setAdaptiveReferenceAndIntent('geometry_face', 0, { boundarySource: 'geometry' })
                      }}
                    />
                  )}
                  <div className="op-pass-summary" data-testid="adaptive-stock-smart-height-preview">
                    <LiveSmartHeightPlan
                      preview={planarRoughHeightPreview}
                      idleMessage={SMART_HEIGHT_V2_REPAIR_MESSAGE}
                      repairMessage={heightRepairMessage}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="op-pass-summary" data-testid="adaptive-geometry-smart-height-preview">
                    <LiveSmartHeightPlan
                      preview={planarRoughHeightPreview}
                      idleMessage={tx('NewOperationModalBody.Select_one_geometry_and_loop_to_resolve_its', { p1: planarRoughGeometryTargetLabel })}
                      repairMessage={heightRepairMessage}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Geometry picker (non-face, or face with Contour source) ────── */}
          {/* ── Parallel 3D finish: pick the SOLID (whole mesh/brep part) ────── */}
          {tab === 'geometry' && (isParallel3d || isSteepShallow3d || isScallop3d || isPencil3d) && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Source_solid')}</p>
              {parallel3dSolids.length === 0 ? (
                <div className="op-no-tool-notice">
                  <Layers size={28} />
                  <span className="op-no-tool-title">{tx('NewOperationModalBody.No_3D_solid_loaded')}</span>
                  <span className="op-no-tool-body">{tx('NewOperationModalBody.Import_an_STL_or_STEP_model_from_the_Design')}</span>
                </div>
              ) : (
                <>
                  <button
                    className="op-pick-btn"
                    data-testid={isSteepShallow3d ? 'op-steep-shallow3d-pick-source' : isScallop3d ? 'op-scallop3d-pick-source' : isPencil3d ? 'op-pencil3d-pick-source' : 'op-parallel3d-pick-source'}
                    onClick={startSourcePartPicking}
                  >
                    <MousePointer2 size={14} />{tx('NewOperationModalBody.Pick_source_part_in_viewport')}</button>
                  <select
                    className="mform-select"
                    data-testid={isSteepShallow3d ? 'op-steep-shallow3d-part-select' : isScallop3d ? 'op-scallop3d-part-select' : isPencil3d ? 'op-pencil3d-part-select' : 'op-parallel3d-part-select'}
                    value={parallelHeightPartIdEff}
                    onChange={e => isSteepShallow3d
                      ? setSteepShallow3dPartId(e.target.value)
                      : isScallop3d ? setScallop3dPartId(e.target.value) : isPencil3d ? setPencil3dPartId(e.target.value) : setParallel3dPartId(e.target.value)}
                  >
                  <option value="">{tx('NewOperationModalBody.Select_a_solid')}</option>
                  {parallel3dSolids.map(g => (
                    <option key={g.id} value={g.id}>
                      {/* WO-1954: the label follows the shared capability map -
                          Parallel, (WO-1957) Scallop, (WO-1958) Steep/Shallow
                          and (WO-1959) Pencil compute a modeled body. */}
                      {geometryDisplayName(g, project.modelItems)}{tx('NewOperationModalBody.symbol_4')}{g.type === 'brep' ? tx('NewOperationModalBody.STEP_model') : g.type === 'model'
                        ? modelBindingCapability.computeSupported ? tx('NewOperationModalBody.Modeled_body') : tx('NewOperationModalBody.Modeled_body_compute_pending')
                        : tx('NewOperationModalBody.STL_mesh')}{tx('NewOperationModalBody.symbol_5')}</option>
                  ))}
                  </select>
                  {faceScopeBlock}
                </>
              )}
            </div>
          )}

          {/* ── Waterline 3D finish: pick the SOLID (whole mesh/brep part) (WO-1176) ── */}
          {tab === 'geometry' && isWaterline3d && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Source_solid')}</p>
              {parallel3dSolids.length === 0 ? (
                <div className="op-no-tool-notice">
                  <Waves size={28} />
                  <span className="op-no-tool-title">{tx('NewOperationModalBody.No_3D_solid_loaded')}</span>
                  <span className="op-no-tool-body">{tx('NewOperationModalBody.Import_an_STL_or_STEP_model_from_the_Design')}</span>
                </div>
              ) : (
                <>
                  <button
                    className="op-pick-btn"
                    data-testid="op-waterline3d-pick-source"
                    onClick={startSourcePartPicking}
                  >
                    <MousePointer2 size={14} />{tx('NewOperationModalBody.Pick_source_part_in_viewport')}</button>
                  <select
                    className="mform-select"
                    data-testid="op-waterline3d-part-select"
                    value={waterline3dPartIdEff}
                    onChange={e => setWaterline3dPartId(e.target.value)}
                  >
                  <option value="">{tx('NewOperationModalBody.Select_a_solid')}</option>
                  {parallel3dSolids.map(g => (
                    <option key={g.id} value={g.id}>
                      {/* WO-1956: the label follows the shared capability map. */}
                      {geometryDisplayName(g, project.modelItems)}{tx('NewOperationModalBody.symbol_4')}{g.type === 'brep' ? tx('NewOperationModalBody.STEP_model') : g.type === 'model'
                        ? modelBindingCapability.computeSupported ? tx('NewOperationModalBody.Modeled_body') : tx('NewOperationModalBody.Modeled_body_compute_pending')
                        : tx('NewOperationModalBody.STL_mesh')}{tx('NewOperationModalBody.symbol_5')}</option>
                  ))}
                  </select>
                  {faceScopeBlock}
                </>
              )}
            </div>
          )}

          {/* ── Adaptive 3D rough: pick the SOLID (whole mesh/brep part) ────── */}
          {tab === 'geometry' && isAdaptive3d && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Source_solid')}</p>
              {parallel3dSolids.length === 0 ? (
                <div className="op-no-tool-notice">
                  <Waypoints size={28} />
                  <span className="op-no-tool-title">{tx('NewOperationModalBody.No_3D_solid_loaded')}</span>
                  <span className="op-no-tool-body">{tx('NewOperationModalBody.Create_a_solid_in_the_Model_workspace_or_import')}</span>
                </div>
              ) : (
                <>
                  <button
                    className="op-pick-btn"
                    data-testid="op-adaptive3d-pick-source"
                    onClick={startSourcePartPicking}
                  >
                    <MousePointer2 size={14} />{tx('NewOperationModalBody.Pick_source_part_in_viewport')}</button>
                  <select
                    className="mform-select"
                    data-testid="op-adaptive3d-part-select"
                    value={adaptive3dPartIdEff}
                    onChange={e => setAdaptive3dPartId(e.target.value)}
                  >
                  <option value="">{tx('NewOperationModalBody.Select_a_solid')}</option>
                  {parallel3dSolids.map(g => (
                    <option key={g.id} value={g.id}>
                      {geometryDisplayName(g, project.modelItems)}{tx('NewOperationModalBody.symbol_4')}{g.type === 'brep' ? tx('NewOperationModalBody.STEP_model') : g.type === 'model' ? tx('NewOperationModalBody.LienCAM_modeled_solid') : tx('NewOperationModalBody.STL_mesh')}{tx('NewOperationModalBody.symbol_5')}</option>
                  ))}
                  </select>
                </>
              )}
            </div>
          )}

          {tab === 'geometry' && !isParallel3d && !isWaterline3d && !isSteepShallow3d && !isScallop3d && !isPencil3d && !isAdaptive3d && (!isFace || face.boundarySource !== 'stock') &&
            !(isPocket && pocket.boundarySource === 'stock') &&
            !(isAdaptive && adaptive.boundarySource === 'stock') && (
            <div className="op-tab-content">
              <p className="op-section-label">{tx('NewOperationModalBody.Source_geometry')}</p>
              {(() => {
                // B-rep solids are valid sources even before any loops exist —
                // their loops are derived on demand (Pick face / edges / holes).
                // CAM-BINDING Stage 1: a modeled body (type 'model', no loops) is
                // now ALSO a valid source, via isModelOpSourceEligible in the
                // operationSourceGeometries filter above - selectable, but whole-
                // body compute availability comes from the shared capability map.
                // CAM-BINDING Stage 4: Section-at-Z also offers itself for a
                // modeled-body selection (isModelSectionGeo below). WO-251 adds
                // cached STL feature chains for Contour; modeled-body and B-rep
                // face/edge picking retain their separate identity contracts.
                // WO-258: every family the shared admission predicate names -
                // Contour, and now Pocket - reaches those chains through this
                // same list; nothing here is per-operation any more.
                const sourceGeos = operationSourceGeometries
                return sourceGeos.length === 0 ? (
                <div className="op-no-tool-notice">
                  <Layers size={28} />
                  <span className="op-no-tool-title">{tx('NewOperationModalBody.No_geometry_loaded')}</span>
                  <span className="op-no-tool-body">
                    {familyDerivesFromStl(opType)
                      ? tx('NewOperationModalBody.Import_an_SVG_DXF_or_STL_file_to_get')
                      : tx('NewOperationModalBody.Import_an_SVG_or_DXF_file_to_get_loop')}
                  </span>
                </div>
              ) : (
                <>
                  {viewportPickSourceGeometries.length > 0 && (
                    <button
                      className="op-pick-btn"
                      data-testid="op-pick-source-part"
                      onClick={startSourcePartPicking}
                    >
                      <MousePointer2 size={14} />{tx('NewOperationModalBody.Pick_source_part_in_viewport')}</button>
                  )}
                  <select
                    className="mform-select"
                    data-testid="op-geometry-select"
                    value={geoId}
                    onChange={e => setGeoId(e.target.value)}
                  >
                  <option value="">{tx('NewOperationModalBody.Select_geometry_file')}</option>
                  {allGeoSources.length > 1 && (
                    <option value="__all__">
                      {/* INT-17A-R1 C2: counted through the SAME resolver the
                          compute seam uses, so the label can never promise loops
                          the operation will refuse to cut. */}{tx('NewOperationModalBody.All_Parts')}{allGeoSources.reduce((n, g) => n + (g.loops?.filter(l => l.closed).length ?? 0), 0)}{tx('NewOperationModalBody.combined_loops')}</option>
                  )}
                  {sourceGeos.map(g => (
                      <option key={g.id} value={g.id}>
                        {(g.type === 'model'
                          // Supported profile operations compute through the
                          // shared derive-then-bind route; drill computes after
                          // Detect holes. Other modes retain the named refusal.
                          ? modelBindingCapability.computeSupported
                            ? tx('NewOperationModalBody.modeled_body', { p1: geometryDisplayName(g, project.modelItems) })
                            : tx('NewOperationModalBody.modeled_body_compute_pending', { p1: geometryDisplayName(g, project.modelItems) })
                          : operationAcceptsMeshEdgeChains(opType) && g.type === 'mesh' && g.format === 'stl'
                            ? stlChainSourceLabel(g)
                          // WO-2859: an STL whose holes are not detected yet says
                          // what it is, never "0 closed loops".
                          : stlDerivesOnSelectionFor(g, opType) && (geometryForOperation(g, opType).loops ?? []).length === 0
                            ? `${geometryDisplayName(g, project.modelItems)}${tx('NewOperationModalBody.symbol_4')}${tx('NewOperationModalBody.STL_mesh')}${tx('NewOperationModalBody.symbol_5')}`
                          : tx('NewOperationModalBody.closed_loops_2', { p1: geometryDisplayName(g, project.modelItems), p2: (geometryForOperation(g, opType).loops ?? []).filter(l => l.closed).length, p3: g.type === 'brep' ? tx('NewOperationModalBody.3D_model') : '' }))
                          // WO-1521: annotate a nest-owned seed on EVERY branch.
                          + nestSeedSuffix(g, project.nests)}
                      </option>
                    ))}
                  </select>
                </>
              )
              })()}

              {modelEdgeChainDropNotice && (
                <span className="op-hint op-hint-warn" data-testid="model-edge-chain-dropped">
                  {modelEdgeChainDropNotice}
                </span>
              )}
              {/* The hint names edge chains, so it shows only for a family that
                  loads them; a drill's hole detection (WO-2859) is quick. */}
              {selectedGeo?.type === 'mesh' && selectedGeo.format === 'stl' && isDerivingPickedSourcePart && operationAcceptsMeshEdgeChains(opType) && (
                <span className="op-hint" data-testid="mesh-edge-chain-deriving">{tx('NewOperationModalBody.Deriving_edge_chains_from_the_picked_STL')}</span>
              )}
              {selectedGeo?.type === 'mesh' && selectedGeo.format === 'stl' && brepDeriveError && (
                <span className="op-hint op-hint-warn" data-testid="mesh-edge-chain-error">
                  {readableInternalIds(brepDeriveError)}
                </span>
              )}
              {/* B-rep derive buttons — brep source: pick face/edges/holes + section;
                  model source (CAM-BINDING Stage 4): section only. */}
              {showBrepDeriveBlock && (
                <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.From_3D_model')}</p>
                  {canPickModelEdges && (
                    <div className="op-toggle-row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
                      <button className="op-pick-btn" data-testid="model-pick-edges"
                        disabled={brepDeriving !== null} onClick={startModelEdgePick}>
                        <MousePointer2 size={14} /> {effectiveModelEdgeChain ? tx('NewOperationModalBody.Re_pick_edges') : tx('NewOperationModalBody.Pick_edges')}
                      </button>
                      {modelEdgeChain && (
                        <button className="op-pick-btn" data-testid="model-edges-clear"
                          onClick={clearModelEdgeChain}>
                          {isEngrave || isVCarve || isChamfer ? tx('NewOperationModalBody.Clear_pick') : tx('NewOperationModalBody.Clear_use_whole_part')}
                        </button>
                      )}
                      <span className="op-hint" data-testid="model-edge-readout" style={{ marginBottom: 0 }}>
                        {effectiveModelEdgeChain
                          ? tx('NewOperationModalBody.edge_s_bound_as_this', { p1: effectiveModelEdgeChain.edgeStableIds.length }) +
                            `${isPocket ? tx('NewOperationModalBody.pocket_boundary') : isAdaptive ? tx('NewOperationModalBody.clearing_boundary') : isEngrave ? tx('NewOperationModalBody.engrave_path') : isVCarve ? tx('NewOperationModalBody.V_carve_region') : isChamfer ? tx('NewOperationModalBody.chamfer_loop') : tx('NewOperationModalBody.Census_contour')}.`
                          : isEngrave
                          ? tx('NewOperationModalBody.No_edges_picked_yet_pick_the_edges_to_engrave')
                          : isVCarve
                          ? tx('NewOperationModalBody.No_edges_picked_yet_pick_the_closed_edges_of')
                          : isChamfer
                          ? tx('NewOperationModalBody.No_edges_picked_yet_pick_the_closed_loop_of')
                          : tx('NewOperationModalBody.No_edges_picked_yet_the_whole_body_outline_is')}
                      </span>
                    </div>
                  )}
                  {modelEdgePickError && (
                    <span className="op-hint op-hint-warn" data-testid="model-edge-pick-error">
                      {readableInternalIds(modelEdgePickError)}
                    </span>
                  )}
                  {effectiveModelEdgeChain && modelEdgeMigratedIds.length > 0 && (
                    <span className="op-hint op-hint-warn" data-testid="model-edge-migrated">{tx('NewOperationModalBody.picked_edge_s_re_bound_by_lineage_after_a', { p1: modelEdgeMigratedIds.length, p2: modelEdgeMigratedIds.join(', ') })}</span>
                  )}
                  {((isBrepGeo && (showPickFace || showPickEdges || isDrill)) || (isModelSectionGeo && (isDrill || isBore || isThreadMill))) && (
                    <div className="op-toggle-row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
                      {isBrepGeo && showPickFace && (
                        <button className="op-pick-btn" data-testid="brep-pick-face"
                          disabled={brepDeriving !== null} onClick={startBrepFacePick}>
                          <MousePointer2 size={14} />{tx('NewOperationModalBody.Pick_face')}</button>
                      )}
                      {canPickModelBoreWall && <button className="op-pick-btn" data-testid="brep-pick-face" disabled={brepDeriving !== null} onClick={startModelBoreFacePick}><MousePointer2 size={14} />{tx('NewOperationModalBody.Pick_face')}</button>}
                      {isBrepGeo && showPickEdges && (
                        <button className="op-pick-btn" data-testid="brep-pick-edges"
                          disabled={brepDeriving !== null} onClick={startBrepEdgePick}>
                          <MousePointer2 size={14} />{tx('NewOperationModalBody.Pick_edges_2')}</button>
                      )}
                      {isDrill && (isBrepGeo || isModelSectionGeo) && (
                        <button className="op-pick-btn" data-testid="brep-detect-holes"
                          disabled={brepDeriving !== null} onClick={() => void runBrepDerive('holes')}>
                          <Circle size={14} />{tx('NewOperationModalBody.Detect_holes')}</button>
                      )}
                    </div>
                  )}
                  {showSectionZ && (isBrepGeo || (isModelSectionGeo && modelProfileComputeSupported)) && (
                    <div className="op-toggle-row" style={{ marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button className="op-pick-btn" data-testid="brep-section-z"
                        disabled={brepDeriving !== null}
                        onClick={() => void runBrepDerive('section', { z: brepSectionZ })}>
                        <Scissors size={14} />{tx('NewOperationModalBody.Section_at_Z')}</button>
                      {/* Live viewport scrub preview stays brep-only for now (it
                          calls the occt-model worker's read-only deriveSection
                          directly) - a model source uses the typed-Z + button
                          flow only (Stage 4 scope; disclosed in the delivery
                          report, not a silent omission). */}
                      {isBrepGeo && (
                        <button className="op-pick-btn" data-testid="brep-section-viewport"
                          disabled={brepDeriving !== null}
                          data-tooltip={tx('NewOperationModalBody.Drag_or_type_the_height_in_the_viewport_and')}
                          onClick={startSectionScrub}>
                          <MousePointer2 size={14} />{tx('NewOperationModalBody.Set_in_viewport')}</button>
                      )}
                      <input
                        className="op-field-input"
                        data-testid="brep-section-z-input"
                        type="text"
                        inputMode="decimal"
                        onFocus={(e) => e.currentTarget.select()}
                        step={0.5}
                        min={Number(fmtZ(brepZMin))}
                        max={Number(fmtZ(brepZMax))}
                        style={{ width: 88 }}
                        value={brepSectionZStr ?? fmtZ((brepZMin + brepZMax) / 2)}
                        onChange={e => setBrepSectionZStr(e.target.value)}
                        onBlur={() => setBrepSectionZStr(fmtZ(brepSectionZ))}
                      />
                      <span className="op-hint" style={{ marginBottom: 0 }}>{unitLabel(displayUnits)}</span>
                      <span className="op-hint" data-testid="brep-section-range-hint" style={{ marginBottom: 0 }}>
                        {tx('NewOperationModalBody.Z_range_coords_at_this_height', { p1: fmtZ(brepZMin), p2: fmtZ(brepZMax), p3: isModelSectionGeo ? tx('NewOperationModalBody.Census_world') : tx('NewOperationModalBody.Census_model'), p4: isModelSectionGeo
                            ? tx('NewOperationModalBody.Mesh_derived_cross_section_display_tessellation_precision')
                            : tx('NewOperationModalBody.Exact_solid_cross_section') })}
                      </span>
                    </div>
                  )}
                  {brepDeriving !== null && (
                    <span className="op-hint" data-testid="brep-deriving">{tx('NewOperationModalBody.Deriving_loops_from_the_model', { p1: brepDeriving })}</span>
                  )}
                  {brepDeriveError && (
                    <span className="op-hint op-hint-warn" data-testid="brep-derive-error">
                      {readableInternalIds(brepDeriveError)}
                    </span>
                  )}
                  {brepFaceDepthHint && (
                    <span className="op-hint" data-testid="brep-face-depth-hint">
                      {brepFaceDepthHint}
                    </span>
                  )}
                </>
              )}

              {/* CAM-BINDING Stage 5: pick a SINGLE face on the modeled body as this
                  op's durable machining-boundary reference - distinct from the
                  multi-face derive block above (that lands a one-time Loop2D
                  snapshot; this stores a ModelReference that stays live, re-
                  resolved on every model regen, and re-derived fresh on every
                  compute - see modelReferences on the op). */}
              {canPickMachiningBoundaryFace && (
                <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Machining_boundary')}</p>
                  <div className="op-toggle-row" style={{ marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="op-pick-btn"
                      data-testid="machining-boundary-pick"
                      disabled={machiningBoundaryPickActive}
                      onClick={machiningBoundaryPickActive ? cancelMachiningBoundaryFacePick : startMachiningBoundaryFacePick}
                    >
                      <MousePointer2 size={14} />
                      {machiningBoundaryPickActive
                        ? tx('NewOperationModalBody.Click_a_face_in_the_viewport')
                        : machiningBoundaryFace
                          ? tx('NewOperationModalBody.Re_pick_face')
                          : tx('NewOperationModalBody.Pick_face_on_model')}
                    </button>
                    {machiningBoundaryPickActive && (
                      <button className="op-pick-btn" data-testid="machining-boundary-cancel-pick"
                        onClick={cancelMachiningBoundaryFacePick}>{tx('NewOperationModalBody.Cancel_2')}</button>
                    )}
                    {machiningBoundaryFace && !machiningBoundaryPickActive && (
                      <button className="op-pick-btn" data-testid="machining-boundary-clear"
                        onClick={() => { setMachiningBoundaryFace(null); setMachiningBoundaryPickError(null) }}>{tx('NewOperationModalBody.Clear_use_whole_part')}</button>
                    )}
                  </div>
                  <span className="op-hint" data-testid="machining-boundary-readout" style={{ marginBottom: 0 }}>
                    {machiningBoundaryFace
                      ? pickedFaceDisplayName(machiningBoundaryGeo ? geometryDisplayName(machiningBoundaryGeo, project.modelItems) : undefined)
                      : tx('NewOperationModalBody.No_face_picked_yet_the_operation_uses_the_whole')}
                  </span>
                  {machiningBoundaryPickError && (
                    <span className="op-hint op-hint-warn" data-testid="machining-boundary-pick-error">
                      {readableInternalIds(machiningBoundaryPickError)}
                    </span>
                  )}
                </>
              )}

              {(selectedGeo || isAllGeo) && isContour && (
                <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Path_type')}</p>
                  <div className="op-toggle-row" data-testid="contour-path-type">
                    <button
                      className={`op-toggle-btn ${contourPathType === 'closed' ? 'op-toggle-active' : ''}`}
                      data-testid="contour-path-closed"
                      onClick={() => {
                        setUserClearedLoops(true)
                        setContour(current => ({ ...current, pathType: 'closed', loopIds: [] }))
                        pushPickedLoopsToViewport([])
                      }}
                    >{tx('NewOperationModalBody.Closed_profile')}</button>
                    {selectedGeo?.type !== 'model' && (
                      <button
                        className={`op-toggle-btn ${contourPathType === 'open' ? 'op-toggle-active' : ''}`}
                        data-testid="contour-path-open"
                        onClick={() => {
                          setUserClearedLoops(true)
                          setContour(current => ({
                            ...current,
                            pathType: 'open',
                            openSide: current.openSide ?? 'right',
                            loopIds: [],
                          }))
                          pushPickedLoopsToViewport([])
                        }}
                      >{tx('NewOperationModalBody.Open_contour')}</button>
                    )}
                  </div>
                  {contourHasNoEligiblePaths && (
                    <span className="op-hint op-hint-warn" data-testid="contour-path-empty">{tx('NewOperationModalBody.This_source_has_no_to_machine', { p1: contourPathType === 'open' ? tx('NewOperationModalBody.open_paths') : tx('NewOperationModalBody.closed_profiles') })}</span>
                  )}
                </>
              )}

              {(selectedGeo || isAllGeo) && closedLoops.length > 0 && (
                <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Loops_to_machine')}</p>







                  <div className="op-toggle-row" style={{ marginBottom: 10 }}>
                    <button
                      className={`op-toggle-btn ${closedLoops.length > 0 && selectedLoopIds.length === closedLoops.length ? 'op-toggle-active' : ''}`}
                      onClick={selectAllLoops}
                    >{tx('NewOperationModalBody.All_loops', { p1: closedLoops.length })}</button>
                    <button
                      className="op-toggle-btn"
                      data-testid="op-loops-clear"
                      data-tooltip={tx('NewOperationModalBody.Unselect_every_loop_The_operation_will_have_nothing_to')}
                      disabled={selectedLoopIds.length === 0 && userClearedLoops}
                      onClick={clearLoopSelection}
                    >{tx('NewOperationModalBody.Clear_selection_2')}</button>
                  </div>

                  {loopsExplicitlyEmpty && (
                    <span className="op-hint op-hint-warn" data-testid="op-loops-empty-warn" style={{ marginBottom: 10 }}>{tx('NewOperationModalBody.No_loops_selected_nothing_to_machine_Pick_at_least')}</span>
                  )}


                  <button
                    className="op-pick-btn"
                    data-testid="op-loop-pick-toggle"
                    aria-pressed={isPickingLoops}
                    onClick={isPickingLoops ? stopLoopPicking : startLoopPicking}
                  >
                    {isPickingLoops ? <CheckCircle2 size={14} /> : <MousePointer2 size={14} />}
                    {isPickingLoops ? tx('NewOperationModalBody.Done_picking') : tx('NewOperationModalBody.Pick_from_viewport')}
                    {selectedLoopIds.length > 0 && (
                      <span className="op-pick-count">{tx('NewOperationModalBody.selected', { p1: selectedLoopIds.length })}</span>
                    )}
                  </button>

                  <div className="op-loop-list">
                    {closedLoopRows.map(row => {
                      const { loop, source } = row
                      // Only legacy edited operations use empty + not-cleared as
                      // "all". New Pocket sketch defaults and authored
                      // All-loops choices store every selected loop id.
                      const allByDefault = selectedLoopIds.length === 0 && !userClearedLoops
                      // WO-2859: an STL chain row under All Parts is checked
                      // for the part it was ticked on, not for every copy.
                      const instanceRow = isChainInstanceRow(row)
                      const checked = allByDefault || (instanceRow
                        ? isMeshChainInstancePicked(selectedLoopIds, meshChainPicks, loop.id, source.id)
                        : selectedLoopIds.includes(loop.id))
                      const sourceGeoName = isAllGeo ? source.name : undefined
                      const chamferSide = chamfer.loopSides[loop.id] ??
                        (loop.type === 'hole' ? 'inner' : 'outer')
                      return (
                        <div key={isAllGeo ? `${source.id}:${loop.id}` : loop.id} className={`op-loop-check ${checked && !allByDefault ? 'op-loop-check-active' : ''}`}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                // Compute the NEXT selection explicitly so we can both store it
                                // and push the same value to the viewport (the old code pushed
                                // the STALE pre-update array). From the "all" default, unchecking
                                // one box materialises every-other-loop; otherwise toggle this id.
                                if (instanceRow) {
                                  // WO-2859: tick or untick THIS part's copy of the
                                  // chain in the one pick list; the id stays picked
                                  // while any copy is. A pick on every copy (no
                                  // instance) becomes one pick per listed copy first.
                                  const bindingOf = (r: typeof row) => ({ geometryId: r.source.id, geometryName: r.source.name })
                                  const current: LoopSelectionPick[] = allByDefault
                                    ? [...new Set(closedLoops.map(l => l.id))].map(loopId => ({ loopId }))
                                    : loopSelectionPicks({ geometryId: geoId, loopIds: selectedLoopIds, meshChainSources: meshChainPicks } as never)
                                  const expanded = current.flatMap((pick): LoopSelectionPick[] =>
                                    pick.loopId === loop.id && !pick.instance
                                      ? closedLoopRows.filter(r => r.loop.id === loop.id && isChainInstanceRow(r))
                                        .map(r => ({ loopId: loop.id, instance: bindingOf(r) }))
                                      : [pick])
                                  const picks = checked
                                    ? expanded.filter(pick => !(pick.loopId === loop.id && pick.instance?.geometryId === source.id))
                                    : [...expanded, { loopId: loop.id, instance: bindingOf(row) }]
                                  const next = [...new Set(picks.map(pick => pick.loopId))]
                                  setUserClearedLoops(next.length === 0)
                                  setLoopSelection(picks)
                                  pushPickedLoopsToViewport(next)
                                  return
                                }
                                const next = allByDefault
                                  ? [...new Set(closedLoops.filter(l => l.id !== loop.id).map(l => l.id))]
                                  : (selectedLoopIds.includes(loop.id)
                                      ? selectedLoopIds.filter(x => x !== loop.id)
                                      : [...selectedLoopIds, loop.id])
                                // Reaching empty by unchecking the last box is a genuine "none":
                                // mark it cleared so it does NOT snap back to all-checked.
                                setUserClearedLoops(next.length === 0)
                                setLoopIds(next)
                                pushPickedLoopsToViewport(next)
                              }}
                            />
                            <span className={`tree-loop-type tree-loop-type-${loop.type}`} />
                            <span className="op-loop-label">
                              {loop.name?.trim() || (loop.type === 'open' ? tx('NewOperationModalBody.Open_path') : loop.type === 'hole' ? tx('NewOperationModalBody.Hole_Island') : tx('NewOperationModalBody.Contour_2'))}
                              {loop.name?.trim() && (
                                <span className="op-loop-source">
                                  {loop.type === 'open' ? tx('NewOperationModalBody.Open_path') : loop.type === 'hole' ? tx('NewOperationModalBody.Hole_Island') : tx('NewOperationModalBody.Contour_2')}
                                </span>
                              )}
                              {sourceGeoName && <span className="op-loop-source">{sourceGeoName}</span>}
                              {isDrill || isBore
                                ? <span className="op-loop-area">{tx('NewOperationModalBody.symbol_6')}{fmtDim(2 * Math.sqrt(Math.abs(loop.area) / Math.PI), displayUnits)} {unitLabel(displayUnits)}</span>
                                : <span className="op-loop-area">{fmtArea(loop.area, displayUnits)} {areaLabel(displayUnits)}</span>
                              }
                            </span>
                          </label>
                          {isChamfer && (
                            <div className="op-toggle-row" style={{ marginLeft: 'auto', gap: 4 }}>
                              <button
                                className={`op-toggle-btn ${chamferSide === 'outer' ? 'op-toggle-active' : ''}`}
                                style={{ padding: '2px 8px', fontSize: 11 }}
                                onClick={() => setChamfer(c => ({
                                  ...c, loopSides: { ...c.loopSides, [loop.id]: 'outer' }
                                }))}
                              >{tx('NewOperationModalBody.Outside')}</button>
                              <button
                                className={`op-toggle-btn ${chamferSide === 'inner' ? 'op-toggle-active' : ''}`}
                                style={{ padding: '2px 8px', fontSize: 11 }}
                                onClick={() => setChamfer(c => ({
                                  ...c, loopSides: { ...c.loopSides, [loop.id]: 'inner' }
                                }))}
                              >{tx('NewOperationModalBody.Inside')}</button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Chamfer milling direction */}
              {(geoId || isAllGeo) && isChamfer && (
                <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Milling_direction')}</p>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${chamfer.direction === 'climb' ? 'op-toggle-active' : ''}`}
                      onClick={() => setChamfer(c => ({ ...c, direction: 'climb' }))}
                    >{tx('NewOperationModalBody.Climb')}</button>
                    <button
                      className={`op-toggle-btn ${chamfer.direction === 'conventional' ? 'op-toggle-active' : ''}`}
                      onClick={() => setChamfer(c => ({ ...c, direction: 'conventional' }))}
                    >{tx('NewOperationModalBody.Conventional')}</button>
                  </div>
                </>
              )}

              {/* WO-3021: chamfers the part already has - pick one, or all. */}
              {isChamfer && modeledChamferReadable && (() => {
                const mm = (v: number) => `${fmtDim(v, displayUnits)} ${unitLabel(displayUnits)}`
                const fmtDegrees = (d: number) => String(Number(d.toFixed(1)))
                const deg = (angleFromAxisDeg: number) => fmtDegrees(angleFromAxisDeg * 2)
                const scan = modeledChamferScan?.geoId === geoId ? modeledChamferScan : null
                const loopLabel = (loopId: string) => {
                  const loop = closedLoops.find(l => l.id === loopId)
                  return loop?.name?.trim() || (loop?.type === 'hole' ? tx('NewOperationModalBody.Hole_Island') : tx('NewOperationModalBody.Contour_2'))
                }
                return (
                  <div data-testid="chamfer-from-model">
                    <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.From_the_model')}</p>
                    {(!scan || scan.state === 'loading') && (
                      <div className="op-hint"><Loader2 size={12} className="spin" />{tx('NewOperationModalBody.Modeled_chamfers_reading')}</div>
                    )}
                    {scan?.state === 'error' && (
                      <div className="op-hint op-hint-warn">{tx('NewOperationModalBody.Modeled_chamfers_read_failed', { p1: scan.message })}</div>
                    )}
                    {scan?.state === 'ready' && !modeledChamferResult && (
                      <div className="op-hint">{tx('NewOperationModalBody.Modeled_chamfers_no_mesh')}</div>
                    )}
                    {modeledChamferResult && modeledChamferResult.passes.length === 0 && modeledChamferResult.pending.length === 0 && (
                      <div className="op-hint">{tx('NewOperationModalBody.Modeled_chamfers_none')}</div>
                    )}
                    {modeledChamferResult && (modeledChamferResult.passes.length > 0 || modeledChamferResult.pending.length > 0) && (
                      <>
                        <button
                          className="op-toggle-btn"
                          data-testid="chamfer-from-model-all"
                          disabled={modeledChamferDeriving?.state === 'running'}
                          onClick={() => { void fillModeledChamfers(modeledChamferResult) }}
                        >{tx('NewOperationModalBody.All_modeled_chamfers', { p1: modeledChamferResult.loops.length + modeledChamferResult.pending.length })}</button>
                        <button
                          className={`op-toggle-btn ${modeledChamferPicking ? 'op-toggle-active' : ''}`}
                          style={{ marginLeft: 6 }}
                          data-testid="chamfer-from-model-pick-view"
                          onClick={() => modeledChamferPicking ? stopModeledChamferPick() : startModeledChamferPick(modeledChamferResult)}
                        >{modeledChamferPicking ? tx('NewOperationModalBody.Pick_modeled_chamfer_stop') : tx('NewOperationModalBody.Pick_modeled_chamfer_in_view')}</button>
                        {modeledChamferPicking && (
                          <div className="op-hint" data-testid="chamfer-from-model-pick-hint">{tx('NewOperationModalBody.Modeled_chamfer_pick_hint')}</div>
                        )}
                        {modeledChamferPicking && modeledChamferPickMissed && (
                          <div className="op-hint" data-testid="chamfer-from-model-pick-missed">{tx('NewOperationModalBody.Modeled_chamfer_pick_missed')}</div>
                        )}
                        {modeledChamferPicking && modeledChamferPickSeveral > 1 && (
                          <div className="op-hint" data-testid="chamfer-from-model-pick-several">{tx('NewOperationModalBody.Modeled_chamfer_pick_several', { p1: modeledChamferPickSeveral })}</div>
                        )}
                        <div className="op-loop-list" data-testid="chamfer-from-model-list">
                          {modeledChamferResult.loops.map(found => (
                            <div key={found.rowId} className="op-loop-check" data-testid={`chamfer-from-model-row-${found.rowId}`}>
                              <span className="op-loop-label">
                                {loopLabel(found.loopId)}
                                <span className="op-loop-source">{tx('NewOperationModalBody.Modeled_chamfer_row', {
                                  p1: mm(found.depthMm), p2: mm(found.widthMm), p3: deg(found.angleFromAxisDeg), p4: mm(found.topZ),
                                })}{found.extent ? tx('NewOperationModalBody.Modeled_chamfer_row_partial', {
                                  p1: mm(found.coveredMm), p2: mm(found.loopLengthMm),
                                }) : ''}</span>
                              </span>
                              <button
                                className="op-toggle-btn"
                                style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }}
                                data-testid={`chamfer-from-model-pick-${found.rowId}`}
                                onClick={() => { void fillModeledChamfers(modeledChamferResult, { rows: [found] }) }}
                              >{tx('NewOperationModalBody.Pick_modeled_chamfer')}</button>
                            </div>
                          ))}
                          {modeledChamferResult.pending.map(found => (
                            <div key={found.featureId} className="op-loop-check" data-testid={`chamfer-from-model-pending-${found.featureId}`}>
                              <span className="op-loop-label">
                                {tx('NewOperationModalBody.Modeled_chamfer_pending_label')}
                                <span className="op-loop-source">{tx('NewOperationModalBody.Modeled_chamfer_row', {
                                  p1: mm(found.depthMm), p2: mm(found.widthMm), p3: deg(found.angleFromAxisDeg), p4: mm(found.topZ),
                                })}</span>
                              </span>
                              <button
                                className="op-toggle-btn"
                                style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }}
                                data-testid={`chamfer-from-model-pick-pending-${found.featureId}`}
                                disabled={modeledChamferDeriving?.state === 'running'}
                                onClick={() => { void fillModeledChamfers(modeledChamferResult, { featureId: found.featureId }) }}
                              >{tx('NewOperationModalBody.Pick_modeled_chamfer')}</button>
                            </div>
                          ))}
                        </div>
                        {modeledChamferResult.pending.length > 0 && (
                          <div className="op-hint" data-testid="chamfer-from-model-pending-hint">{tx('NewOperationModalBody.Modeled_chamfers_pending', { p1: modeledChamferResult.pending.length })}</div>
                        )}
                        {modeledChamferDeriving?.state === 'running' && (
                          <div className="op-hint"><Loader2 size={12} className="spin" />{tx('NewOperationModalBody.Modeled_chamfers_deriving')}</div>
                        )}
                        {modeledChamferDeriving?.state === 'error' && (
                          <div className="op-hint op-hint-warn" data-testid="chamfer-from-model-derive-failed">{tx('NewOperationModalBody.Modeled_chamfers_derive_failed', { p1: modeledChamferDeriving.message })}</div>
                        )}
                      </>
                    )}
                    {modeledChamferResult && modeledChamferResult.skipped.length > 0 && (
                      <div className="op-hint">{tx('NewOperationModalBody.Modeled_chamfers_skipped', { p1: modeledChamferResult.skipped.length })}</div>
                    )}
                    {modeledChamferResult && modeledChamferResult.unmatched - modeledChamferResult.pending.length > 0 && (
                      <div className="op-hint">{tx('NewOperationModalBody.Modeled_chamfers_unmatched', { p1: modeledChamferResult.unmatched - modeledChamferResult.pending.length })}</div>
                    )}
                    {modeledChamferRecord && (
                      <div className="op-pass-summary" data-testid="chamfer-from-model-filled">
                        <span>{tx('NewOperationModalBody.Modeled_chamfer_filled', {
                          p1: mm(modeledChamferRecord.depthMm), p2: mm(modeledChamferRecord.topZ), p3: deg(modeledChamferRecord.angleFromAxisDeg),
                        })}</span>
                      </div>
                    )}
                    {chamferStretch && (
                      <div className="op-pass-summary" data-testid="chamfer-from-model-stretch">
                        <span>{tx('NewOperationModalBody.Modeled_chamfer_stretch', { p1: mm(chamferStretch.stretchMm), p2: chamferStretch.loops })}</span>
                      </div>
                    )}
                    {extraModeledPasses.length > 0 && (
                      <div className="op-pass-summary" data-testid="chamfer-from-model-extra">
                        <span>{tx('NewOperationModalBody.Modeled_chamfer_extra_passes', {
                          p1: extraModeledPasses.length,
                          p2: extraModeledPasses.map(pass => tx('NewOperationModalBody.Modeled_chamfer_extra_pass', {
                            p1: mm(pass.chamferWidth), p2: mm(pass.record.topZ), p3: pass.loopIds.length,
                          })).join('; '),
                        })}</span>
                      </div>
                    )}
                    {modeledChamferNote && (
                      <div className="op-hint op-hint-warn" data-testid="chamfer-angle-note">{tx('NewOperationModalBody.Modeled_chamfer_angle_note', {
                        p1: fmtDegrees(modeledChamferNote.bitIncludedDeg), p2: fmtDegrees(modeledChamferNote.chamferIncludedDeg),
                        p3: mm(modeledChamferNote.depthMm), p4: mm(modeledChamferNote.cutWidthMm), p5: mm(modeledChamferNote.modeledWidthMm),
                      })}</div>
                    )}
                  </div>
                )
              })()}

              {/* Direction — shown for contour/pocket; drill and chamfer have their own controls */}
              {(geoId || isAllGeo) && !isDrill && !isBore && !isThreadMill && !isChamfer && !isFace && !isEngrave && !isVCarve && (
                <>
                  {!isPocket && !isAdaptive && contourPathType === 'closed' && (
                    <>
                      <p className="op-section-label" style={{ marginTop: 16 }}>{tx('NewOperationModalBody.Tool_position')}</p>
                      <div className="op-toggle-row">
                        <button
                          className={`op-toggle-btn ${contour.side === 'outer' ? 'op-toggle-active' : ''}`}
                          onClick={() => setContour(prev => ({ ...prev, side: 'outer' }))}
                        >{tx('NewOperationModalBody.Outside_profile')}</button>
                        <button
                          className={`op-toggle-btn ${contour.side === 'inner' ? 'op-toggle-active' : ''}`}
                          onClick={() => setContour(prev => ({ ...prev, side: 'inner' }))}
                        >{tx('NewOperationModalBody.Inside_profile')}</button>
                      </div>
                    </>
                  )}

                  {!isPocket && !isAdaptive && contourPathType === 'open' && (
                    <>
                      <p className="op-section-label" style={{ marginTop: 16 }}>{tx('NewOperationModalBody.Tool_position')}</p>
                      <div className="op-toggle-row" data-testid="contour-open-side">
                        <button
                          className={`op-toggle-btn ${(contour.openSide ?? 'right') === 'left' ? 'op-toggle-active' : ''}`}
                          onClick={() => setContour(prev => ({ ...prev, openSide: 'left' }))}
                        >{tx('NewOperationModalBody.Left_of_drawn_path')}</button>
                        <button
                          className={`op-toggle-btn ${(contour.openSide ?? 'right') === 'right' ? 'op-toggle-active' : ''}`}
                          onClick={() => setContour(prev => ({ ...prev, openSide: 'right' }))}
                        >{tx('NewOperationModalBody.Right_of_drawn_path')}</button>
                      </div>
                    </>
                  )}

                  {(() => {
                    const dir = isPocket
                      ? pocket.direction
                      : isAdaptive
                        ? resolveAdaptiveMillingDirection(adaptive.climb)
                        : contour.direction
                    const setDir = (d: 'climb' | 'conventional') => {
                      if (isPocket)        setPocket(p => ({ ...p, direction: d }))
                      else if (isAdaptive) setAdaptive(a => ({
                        ...a,
                        climb: encodeAdaptiveMillingDirection(d),
                      }))
                      else                 setContour(c => ({ ...c, direction: d }))
                    }
                    return (
                      <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Milling_direction')}</p>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${dir === 'climb' ? 'op-toggle-active' : ''}`}
                      onClick={() => setDir('climb')}
                    >{tx('NewOperationModalBody.Climb')}</button>
                    <button
                      className={`op-toggle-btn ${dir === 'conventional' ? 'op-toggle-active' : ''}`}
                      onClick={() => setDir('conventional')}
                    >{tx('NewOperationModalBody.Conventional')}</button>
                  </div>
                      </>
                    )
                  })()}
                </>
              )}
            </div>
          )}

          {/* ── Passes ───────────────────────────────────────────────────── */}
          {tab === 'passes' && (
            <div className="op-tab-content">

              {/* ── Waterline 3D finish passes (WO-1176) ── */}
              {isWaterline3d && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Levels')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stepdown')} unit="mm" units={displayUnits}
                    value={waterline3d.stepdown} min={0.05} step={0.1}
                    max={selectedTool ? selectedTool.diameter : undefined}
                    onChange={v => { setWaterlineStepdownTouched(true); setWaterline3d(p => ({ ...p, stepdown: v })) }}
                  />
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={waterline3d.tolerance} min={0.001} step={0.01}
                    onChange={v => setWaterline3d(p => ({ ...p, tolerance: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_to_leave_walls')} unit="mm" units={displayUnits}
                    value={waterline3d.stockToLeave} min={0} step={0.05}
                    max={selectedTool ? selectedTool.diameter : undefined}
                    onChange={v => setWaterline3d(p => ({ ...p, stockToLeave: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Steep_areas_only_above')} unit="°"
                    value={waterline3d.minSlopeDeg} min={0} max={89} step={1}
                    onChange={v => setWaterline3d(p => ({ ...p, minSlopeDeg: v }))}
                  />
                  <div className="op-field-row" data-testid="op-waterline3d-finish-depth">
                    <span className="op-field-label">{tx('NewOperationModalBody.Finish_depth_limit')}</span>
                    <div className="op-field-right">
                      <div className="op-field-input-row">
                        <OptionalNumericInput
                          className="op-field-input"
                          value={waterline3d.finishDepth}
                          min={0.01}
                          step={0.1}
                          units={displayUnits}
                          placeholder={tx('NewOperationModalBody.full_surface')}
                          onChange={(finishDepth) => {
                            setWaterline3dHeightAuthority('smart_v2')
                            setWaterline3d(p => ({ ...p, finishDepth }))
                          }}
                          tooltip={tx('NewOperationModalBody.Lowest_level_below_the_model_top_blank_finishes_down')}
                        />
                        <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                      </div>
                    </div>
                  </div>

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Order_and_direction')}</p>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <label className="op-field-label" htmlFor="waterline3d-order">{tx('NewOperationModalBody.Order')}</label>
                    </div>
                    <div className="op-field-control">
                      <select
                        id="waterline3d-order"
                        className="op-select"
                        data-testid="op-waterline3d-order"
                        value={waterline3d.order}
                        onChange={e => setWaterline3d(p => ({ ...p, order: e.target.value === 'region' ? 'region' : 'level' }))}
                      >
                        <option value="level">{tx('NewOperationModalBody.Level_by_level')}</option>
                        <option value="region">{tx('NewOperationModalBody.Region_by_region')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <label className="op-field-label" htmlFor="waterline3d-direction">{tx('NewOperationModalBody.Direction')}</label>
                    </div>
                    <div className="op-field-control">
                      <select
                        id="waterline3d-direction"
                        className="op-select"
                        data-testid="op-waterline3d-direction"
                        value={waterline3d.direction}
                        onChange={e => setWaterline3d(p => ({ ...p, direction: e.target.value === 'conventional' ? 'conventional' : 'climb' }))}
                      >
                        <option value="climb">{tx('NewOperationModalBody.Climb')}</option>
                        <option value="conventional">{tx('NewOperationModalBody.Conventional')}</option>
                      </select>
                    </div>
                  </div>

                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={waterline3d.flatAreaDetection}
                        data-testid="op-waterline3d-flat-areas"
                        onChange={e => setWaterline3d(p => ({ ...p, flatAreaDetection: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Flat_area_detection')}</span>
                    </label>
                  </div>
                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={waterline3d.useStockBoundary}
                        onChange={e => setWaterline3d(p => ({ ...p, useStockBoundary: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Clip_to_stock_outline')}</span>
                    </label>
                  </div>
                </>
              )}

              {isScallop3d && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Constant_scallop_finish')}</p>
                  <NumberField label={tx('NewOperationModalBody.Scallop_height')} unit="mm" units={displayUnits}
                    value={scallop3d.scallopHeight} min={0.001} step={0.005}
                    max={selectedTool ? selectedTool.diameter / 2 : undefined}
                    onChange={scallopHeight => setScallop3d(p => ({ ...p, scallopHeight }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={scallop3d.tolerance} min={0.001} step={0.01}
                    onChange={tolerance => setScallop3d(p => ({ ...p, tolerance }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_to_leave')} unit="mm" units={displayUnits}
                    value={scallop3d.stockToLeave} min={0} step={0.05}
                    onChange={stockToLeave => setScallop3d(p => ({ ...p, stockToLeave }))}
                  />
                  <div className="op-field-row" data-testid="op-scallop3d-finish-depth">
                    <span className="op-field-label">{tx('NewOperationModalBody.Finish_depth_limit')}</span>
                    <div className="op-field-right">
                      <OptionalNumericInput
                        className="op-field-input"
                        value={scallop3d.finishDepth}
                        min={0.01}
                        step={0.1}
                        units={displayUnits}
                        placeholder={tx('NewOperationModalBody.full_surface')}
                        onChange={finishDepth => setScallop3d(p => ({ ...p, finishDepth }))}
                      />
                    </div>
                  </div>
                  <div className="op-field-row">
                    <label className="op-field-label" htmlFor="scallop3d-direction">{tx('NewOperationModalBody.Direction')}</label>
                    <div className="op-field-control">
                      <select id="scallop3d-direction" className="op-select" value={scallop3d.direction}
                        onChange={event => setScallop3d(p => ({ ...p, direction: event.target.value === 'conventional' ? 'conventional' : 'climb' }))}>
                        <option value="climb">{tx('NewOperationModalBody.Climb')}</option>
                        <option value="conventional">{tx('NewOperationModalBody.Conventional')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={scallop3d.useStockBoundary}
                        onChange={event => setScallop3d(p => ({ ...p, useStockBoundary: event.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Clip_to_stock_outline')}</span>
                    </label>
                  </div>
                </>
              )}

              {isPencil3d && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Pencil_cleanup')}</p>
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={pencil3d.tolerance} min={0.001} step={0.01}
                    onChange={tolerance => setPencil3d(p => ({ ...p, tolerance }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_to_leave')} unit="mm" units={displayUnits}
                    value={pencil3d.stockToLeave} min={0} step={0.05}
                    onChange={stockToLeave => setPencil3d(p => ({ ...p, stockToLeave }))}
                  />
                  <div className="op-field-row" data-testid="op-pencil3d-finish-depth">
                    <span className="op-field-label">{tx('NewOperationModalBody.Finish_depth_limit')}</span>
                    <div className="op-field-right">
                      <OptionalNumericInput className="op-field-input" value={pencil3d.finishDepth}
                        min={0.01} step={0.1} units={displayUnits} placeholder={tx('NewOperationModalBody.full_surface')}
                        onChange={finishDepth => setPencil3d(p => ({ ...p, finishDepth }))} />
                    </div>
                  </div>
                  <div className="op-field-row">
                    <label className="op-field-label" htmlFor="pencil3d-direction">{tx('NewOperationModalBody.Direction')}</label>
                    <div className="op-field-control">
                      <select id="pencil3d-direction" className="op-select" value={pencil3d.direction}
                        onChange={event => setPencil3d(p => ({ ...p, direction: event.target.value === 'conventional' ? 'conventional' : 'climb' }))}>
                        <option value="climb">{tx('NewOperationModalBody.Climb')}</option>
                        <option value="conventional">{tx('NewOperationModalBody.Conventional')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={pencil3d.useStockBoundary}
                        onChange={event => setPencil3d(p => ({ ...p, useStockBoundary: event.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Clip_to_stock_outline')}</span>
                    </label>
                  </div>
                </>
              )}

              {isSteepShallow3d && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Steep_and_shallow_finish')}</p>
                  <NumberField label={tx('NewOperationModalBody.Threshold')} unit="deg"
                    value={steepShallow3d.thresholdDeg} min={0} max={90} step={1}
                    onChange={thresholdDeg => setSteepShallow3d(p => ({ ...p, thresholdDeg }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Steep_stepdown')} unit="mm" units={displayUnits}
                    value={steepShallow3d.stepdown} min={0.05} step={0.1}
                    max={selectedTool ? selectedTool.diameter : undefined}
                    onChange={stepdown => setSteepShallow3d(p => ({ ...p, stepdown }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Shallow_stepover')} unit="mm" units={displayUnits}
                    value={steepShallow3d.stepover} min={0.05} step={0.1}
                    max={selectedTool ? selectedTool.diameter : undefined}
                    onChange={stepover => setSteepShallow3d(p => ({ ...p, stepover }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Shallow_pass_angle')} unit="deg"
                    value={steepShallow3d.angleDeg} min={0} max={180} step={5}
                    onChange={angleDeg => setSteepShallow3d(p => ({ ...p, angleDeg }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={steepShallow3d.tolerance} min={0.001} step={0.01}
                    onChange={tolerance => setSteepShallow3d(p => ({ ...p, tolerance }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_to_leave')} unit="mm" units={displayUnits}
                    value={steepShallow3d.stockToLeave} min={0} step={0.05}
                    onChange={stockToLeave => setSteepShallow3d(p => ({ ...p, stockToLeave }))}
                  />
                  <div className="op-field-row" data-testid="op-steep-shallow3d-finish-depth">
                    <span className="op-field-label">{tx('NewOperationModalBody.Finish_depth_limit')}</span>
                    <div className="op-field-right">
                      <div className="op-field-input-row">
                        <OptionalNumericInput
                          className="op-field-input"
                          value={steepShallow3d.finishDepth}
                          min={0.01}
                          step={0.1}
                          units={displayUnits}
                          placeholder={tx('NewOperationModalBody.full_surface')}
                          onChange={finishDepth => setSteepShallow3d(p => ({ ...p, finishDepth }))}
                        />
                        <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={steepShallow3d.useStockBoundary}
                        onChange={e => setSteepShallow3d(p => ({ ...p, useStockBoundary: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Clip_to_stock_outline')}</span>
                    </label>
                  </div>
                </>
              )}

              {/* ── Parallel 3D finish passes ── */}
              {isParallel3d && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Raster_fill')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stepover')} unit="mm" units={displayUnits}
                    value={parallel3d.stepover} min={0.05} step={0.1}
                    max={selectedTool ? selectedTool.diameter : undefined}
                    onChange={v => setParallel3d(p => ({ ...p, stepover: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Pass_angle')} unit="°"
                    value={parallel3d.angleDeg} min={0} max={180} step={5}
                    onChange={v => setParallel3d(p => ({ ...p, angleDeg: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={parallel3d.tolerance} min={0.001} step={0.01}
                    onChange={v => setParallel3d(p => ({ ...p, tolerance: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Surface_normal_stock_to_leave')} unit="mm" units={displayUnits}
                    value={parallel3d.surfaceStockToLeave ?? 0} min={0} step={0.05}
                    max={selectedTool ? selectedTool.diameter : undefined}
                    onChange={v => setParallel3d(p => ({ ...p, surfaceStockToLeave: v }))}
                  />
                  <div className="op-field-row" data-testid="op-parallel3d-finish-depth">
                    <span className="op-field-label">{tx('NewOperationModalBody.Finish_depth_limit')}</span>
                    <div className="op-field-right">
                      <div className="op-field-input-row">
                        <OptionalNumericInput
                          className="op-field-input"
                          value={parallel3d.finishDepth}
                          min={0.01}
                          step={0.1}
                          units={displayUnits}
                          placeholder={tx('NewOperationModalBody.full_surface')}
                          onChange={(finishDepth) => {
                            setParallel3dHeightAuthority('smart_v2')
                            setParallel3d(p => ({ ...p, finishDepth }))
                          }}
                          tooltip={tx('NewOperationModalBody.Maximum_depth_below_the_model_top_to_finish_blank')}
                        />
                        <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={parallel3d.useStockBoundary}
                        onChange={e => setParallel3d(p => ({ ...p, useStockBoundary: e.target.checked }))} />
                      {/* WO-1271/1279 said this control's NAME promises more than it
                          does, and that is true - but the fix is NOT a hint span.
                          Operator, 2026-09-03 (WO-1182): "You keep adding text in fields
                          all over my clean UI. Stop it from happening again." The
                          clutter census enforces it. The meaning lives in this
                          control's own tooltip and in the help topic, which are the
                          sanctioned channels. */}
                      <span title={tx('NewOperationModalBody.Chooses_which_outline_contains_the_passes_the_stock_outline')}>{tx('NewOperationModalBody.Clip_to_stock_outline')}</span>
                    </label>
                  </div>
                  <div className="op-field-row" data-testid="op-parallel3d-overshoot">
                    <span className="op-field-label">{tx('NewOperationModalBody.Edge_overrun')}</span>
                    <div className="op-field-right">
                      <div className="op-field-input-row">
                        <OptionalNumericInput
                          className="op-field-input"
                          value={parallel3d.stockEdgeOvershoot}
                          min={0}
                          step={0.1}
                          units={displayUnits}
                          placeholder={tx('NewOperationModalBody.auto')}
                          tooltip={tx('NewOperationModalBody.How_far_past_the_outline_the_tool_centre_travels')}
                          onChange={v => setParallel3d(p => ({ ...p, stockEdgeOvershoot: v }))}
                        />
                        <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* ── Adaptive 3D rough passes ── */}
              {isAdaptive3d && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Roughing')}</p>
                  <NumberField label={tx('NewOperationModalBody.Max_stepdown')} unit="mm" units={displayUnits}
                    value={adaptive3d.maxStepdown} min={0.1} step={0.5}
                    onChange={v => setAdaptive3d(p => ({ ...p, maxStepdown: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stepover_fraction_of_tool_dia')} unit=""
                    value={adaptive3d.stepover} min={0.05} max={1} step={0.05}
                    onChange={v => setAdaptive3d(p => ({ ...p, stepover: v }))}
                  />
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Milling_direction')}</p>
                  <div className="op-toggle-row" data-testid="op-adaptive3d-milling-direction">
                    <button
                      className={`op-toggle-btn ${adaptive3d.millingDirection === 'climb' ? 'op-toggle-active' : ''}`}
                      onClick={() => setAdaptive3d(p => ({ ...p, millingDirection: 'climb' }))}
                    >{tx('NewOperationModalBody.Climb')}</button>
                    <button
                      className={`op-toggle-btn ${adaptive3d.millingDirection === 'conventional' ? 'op-toggle-active' : ''}`}
                      onClick={() => setAdaptive3d(p => ({ ...p, millingDirection: 'conventional' }))}
                    >{tx('NewOperationModalBody.Conventional')}</button>
                  </div>
                  <label
                    className="op-check-label"
                    title={tx('NewOperationModalBody.Adds_roughing_cuts_between_full_stepdowns_so_curved_and')}
                  >
                    <input
                      type="checkbox"
                      data-testid="op-adaptive3d-reduce-stair-steps"
                      checked={adaptive3d.intermediateStepdown}
                      onChange={e => setAdaptive3d(p => ({ ...p, intermediateStepdown: e.target.checked }))}
                    />
                    <span>{tx('NewOperationModalBody.Reduce_stair_steps')}</span>
                  </label>
                  <p className="op-hint">{tx('NewOperationModalBody.Adds_roughing_cuts_between_full_stepdowns_so_curved_and')}</p>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Wall_transitions')}</p>
                  <NumberField label={tx('NewOperationModalBody.Wall_lead_in_radius')} unit="mm" units={displayUnits}
                    value={adaptive3d.wallLeadInRadius} min={0} step={0.5}
                    onChange={v => setAdaptive3d(p => ({ ...p, wallLeadInRadius: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Wall_lead_out_radius')} unit="mm" units={displayUnits}
                    value={adaptive3d.wallLeadOutRadius} min={0} step={0.5}
                    onChange={v => setAdaptive3d(p => ({ ...p, wallLeadOutRadius: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Loopback_fillet')} unit={tx('NewOperationModalBody.Percent_tool_radius')}
                    value={adaptive3d.loopbackFilletPct} min={5} max={100} step={5}
                    onChange={v => setAdaptive3d(p => ({ ...p, loopbackFilletPct: v }))}
                  />
                  <label className="op-check-label">
                    <input
                      type="checkbox"
                      checked={adaptive3d.integralWallFollow}
                      onChange={e => setAdaptive3d(p => ({ ...p, integralWallFollow: e.target.checked }))}
                    />
                    <span>{tx('NewOperationModalBody.Integral_wall_follow')}</span>
                  </label>
                  {adaptive3d.integralWallFollow && (
                    <NumberField label={tx('NewOperationModalBody.Maximum_direct_wall_ride')} unit={tx('NewOperationModalBody.Percent_straight_distance')}
                      value={adaptive3d.integralWallFollowLengthFactor * 100}
                      min={10} max={1000} step={10}
                      onChange={v => setAdaptive3d(p => ({
                        ...p,
                        integralWallFollowLengthFactor: Number.isFinite(v) && v > 0 ? v / 100 : 2,
                      }))}
                    />
                  )}
                  <NumberField label={tx('NewOperationModalBody.Entry_helix_diameter')} unit="mm" units={displayUnits}
                    value={adaptive3d.helixDiameter} min={0.5} step={0.5}
                    onChange={v => setAdaptive3d(p => ({ ...p, helixDiameter: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Helix_angle')} unit="deg"
                    value={adaptive3d.helixAngleDeg} min={0.5} max={30} step={0.5}
                    onChange={v => setAdaptive3d(p => ({ ...p, helixAngleDeg: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Radial_stock_to_leave')} unit="mm" units={displayUnits}
                    value={adaptive3d.radialStockToLeave} min={0} step={0.1}
                    onChange={v => setAdaptive3d(p => ({ ...p, radialStockToLeave: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Axial_stock_to_leave')} unit="mm" units={displayUnits}
                    value={adaptive3d.axialStockToLeave} min={0} step={0.1}
                    onChange={v => setAdaptive3d(p => ({ ...p, axialStockToLeave: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={adaptive3d.tolerance} min={0.001} step={0.01}
                    onChange={v => setAdaptive3d(p => ({ ...p, tolerance: v }))}
                  />

                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={adaptive3d.cellSize <= 0}
                        onChange={e => setAdaptive3d(p => ({ ...p, cellSize: e.target.checked ? 0 : (p.cellSize > 0 ? p.cellSize : 0.3) }))} />
                      <span>{tx('NewOperationModalBody.Auto_grid_resolution')}</span>
                    </label>
                  </div>
                  {adaptive3d.cellSize > 0 && (
                    <NumberField label={tx('NewOperationModalBody.Grid_cell_size')} unit="mm" units={displayUnits}
                      value={adaptive3d.cellSize} min={0.1} step={0.1}
                      onChange={v => setAdaptive3d(p => ({ ...p, cellSize: v }))}
                    />
                  )}

                  <div className="op-check-section" style={{ marginTop: 12 }}>
                    {/* This persisted boolean is an explicit machining-scope choice. */}
                    <RoughingScopeSelector
                      name="new-operation-adaptive3d-roughing-scope"
                      useStockBoundary={adaptive3d.useStockBoundary}
                      onChange={useStockBoundary =>
                        setAdaptive3d(p => ({ ...p, useStockBoundary }))
                      }
                      testId="op-adaptive3d-roughing-scope"
                    />
                  </div>

                  {adaptive3d.useStockBoundary && (
                    <>
                      <div className="op-field-row" data-testid="op-adaptive3d-overshoot">
                        <span className="op-field-label">{tx('NewOperationModalBody.Edge_overshoot')}</span>
                        <div className="op-field-right">
                          <div className="op-field-input-row">
                            <OptionalNumericInput
                              className="op-field-input"
                              value={adaptive3d.stockEdgeOvershoot}
                              min={0}
                              step={0.1}
                              units={displayUnits}
                              placeholder={tx('NewOperationModalBody.auto')}
                              tooltip={tx('NewOperationModalBody.Auto_tool_radius')}
                              onChange={v => setAdaptive3d(p => ({ ...p, stockEdgeOvershoot: v }))}
                            />
                            <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              {/* ── V-carve (WO-1174) ── */}
              {isVCarve && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Carve_depth')}</p>
                  <div className="op-toggle-row" style={{ marginBottom: 8 }}>
                    <button className={`op-toggle-btn ${vcarve.flatDepthMm === undefined ? 'op-toggle-active' : ''}`}
                      data-testid="vcarve-depth-tool-limit"
                      onClick={() => setVCarve(v => ({ ...v, flatDepthMm: undefined }))}>{tx('NewOperationModalBody.Bit_s_own_limit')}</button>
                    <button className={`op-toggle-btn ${vcarve.flatDepthMm !== undefined ? 'op-toggle-active' : ''}`}
                      data-testid="vcarve-depth-flat"
                      onClick={() => setVCarve(v => ({ ...v, flatDepthMm: v.flatDepthMm ?? 2 }))}>{tx('NewOperationModalBody.Flat_depth')}</button>
                  </div>
                  {vcarve.flatDepthMm !== undefined ? (
                    <NumberField label={tx('NewOperationModalBody.Flat_depth')} unit="mm" units={displayUnits}
                      value={vcarve.flatDepthMm} min={0.05} max={50} step={0.1}
                      onChange={v => setVCarve(p => ({ ...p, flatDepthMm: v }))}
                    />
                  ) : null}
                  <NumberField label={tx('NewOperationModalBody.Start_depth')} unit="mm" units={displayUnits}
                    value={vcarve.startDepthMm} min={0} max={50} step={0.1}
                    onChange={v => setVCarve(p => ({ ...p, startDepthMm: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stepdown')} unit="mm" units={displayUnits}
                    value={passes.stepdown} min={0} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepdown: v }))}
                  />

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Flat_areas')}</p>
                  <div className="op-toggle-row" style={{ marginBottom: 8 }}>
                    <button className={`op-toggle-btn ${vcarve.flatClearing.mode === 'vbit' ? 'op-toggle-active' : ''}`}
                      data-testid="vcarve-clear-vbit"
                      onClick={() => setVCarve(v => ({ ...v, flatClearing: { ...v.flatClearing, mode: 'vbit' } }))}>{tx('NewOperationModalBody.Clear_with_this_bit')}</button>
                    <button className={`op-toggle-btn ${vcarve.flatClearing.mode === 'tool' ? 'op-toggle-active' : ''}`}
                      data-testid="vcarve-clear-tool"
                      onClick={() => setVCarve(v => ({ ...v, flatClearing: { ...v.flatClearing, mode: 'tool' } }))}>{tx('NewOperationModalBody.Separate_end_mill')}</button>
                    <button className={`op-toggle-btn ${vcarve.flatClearing.mode === 'none' ? 'op-toggle-active' : ''}`}
                      data-testid="vcarve-clear-none"
                      onClick={() => setVCarve(v => ({ ...v, flatClearing: { ...v.flatClearing, mode: 'none' } }))}>{tx('NewOperationModalBody.Leave_floors')}</button>
                  </div>
                  {vcarve.flatClearing.mode === 'tool' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                      <label className="op-field-label">{tx('NewOperationModalBody.Clearing_tool')}</label>
                      <select
                        className="mform-select"
                        data-testid="vcarve-clearing-tool"
                        value={vcarveClearingToolId}
                        onChange={e => setVCarveClearingToolId(e.target.value)}
                      >
                        <option value="">{tx('NewOperationModalBody.Choose_an_end_mill')}</option>
                        {toolLibrary
                          .filter(candidate => candidate.id !== toolId && (candidate.type === 'flat_end_mill' || candidate.type === 'bull_nose' || candidate.type === 'ball_end_mill'))
                          .map(candidate => (
                            <option key={candidate.id} value={candidate.id}>{candidate.name}{tx('NewOperationModalBody.symbol_4')}{fmtDim(candidate.diameter, displayUnits)} {unitLabel(displayUnits)}{tx('NewOperationModalBody.symbol_5')}</option>
                          ))}
                      </select>
                    </div>
                  )}
                  {vcarve.flatClearing.mode !== 'none' && (
                    <NumberField label={tx('NewOperationModalBody.Floor_stepover')} unit="mm" units={displayUnits}
                      value={vcarve.flatClearing.stepoverMm} min={0.05} max={20} step={0.1}
                      onChange={v => setVCarve(p => ({ ...p, flatClearing: { ...p.flatClearing, stepoverMm: v } }))}
                    />
                  )}

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Outline')}</p>
                  <NumberField label={tx('NewOperationModalBody.Allowance')} unit="mm" units={displayUnits}
                    value={vcarve.allowanceMm} min={-10} max={10} step={0.05}
                    onChange={v => setVCarve(p => ({ ...p, allowanceMm: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={vcarve.tolerance} min={0.001} max={1} step={0.005}
                    onChange={v => setVCarve(p => ({ ...p, tolerance: v }))}
                  />
                </>
              )}

              {/* ── Engrave / Trace passes ── */}
              {isEngrave && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Mode')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${engrave.mode === 'trace' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, mode: 'trace' }))}>{tx('NewOperationModalBody.Trace')}</button>
                    <button className={`op-toggle-btn ${engrave.mode === 'engrave' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, mode: 'engrave' }))}>{tx('NewOperationModalBody.V_engrave')}</button>
                  </div>

                  {/* WO-2299: a Trace on the line can cut a slot wider than the tool */}
                  {engrave.mode === 'trace' && engrave.side === 'center' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                      <label className="op-field-label">{tx('NewOperationModalBody.Style')}</label>
                      <select
                        className="mform-select"
                        data-testid="engrave-style"
                        value={engrave.engraveStyle ?? 'plain'}
                        onChange={e => setEngrave(p => ({ ...p, engraveStyle: e.target.value as EngraveStyle }))}
                        data-tooltip={tx('NewOperationModalBody.Plain_cuts_one_pass_along_the_line_Trochoidal_cuts')}
                      >
                        {(Object.keys(ENGRAVE_STYLE_LABELS) as EngraveStyle[]).map(style => (
                          <option key={style} value={style}>{tx(`choices.ENGRAVE_STYLE_LABELS.${style}`)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {engrave.mode === 'trace' && engrave.side === 'center'
                    && engrave.engraveStyle === 'trochoidal' && selectedTool && (() => {
                    const troch = resolveTrochoidalGeometry(
                      selectedTool.diameter, engrave.trochoidalWidth, engrave.trochoidalAdvance)
                    const limits = trochoidalFieldLimits(selectedTool.diameter)
                    return (
                      <>
                        <NumberField label={tx('NewOperationModalBody.Slot_width')} unit="mm" units={displayUnits}
                          value={troch.width} min={limits.width.min} max={limits.width.max} step={0.5}
                          onChange={v => setEngrave(p => ({ ...p, trochoidalWidth: v }))}
                        />
                        <NumberField label={tx('NewOperationModalBody.Advance_per_orbit')} unit="mm" units={displayUnits}
                          value={troch.advance} min={limits.advance.min} max={limits.advance.max} step={0.1}
                          onChange={v => setEngrave(p => ({ ...p, trochoidalAdvance: v }))}
                        />
                      </>
                    )
                  })()}

                  {engrave.mode === 'engrave' && (
                    <>
                      <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.V_engrave_depth')}</p>
                      <div className="op-toggle-row" style={{ marginBottom: 8 }}>
                        <button className={`op-toggle-btn ${engrave.useWidthForDepth ? 'op-toggle-active' : ''}`}
                          onClick={() => {
                            const next = !engrave.useWidthForDepth
                            setEngrave(e => ({ ...e, useWidthForDepth: next }))
                            if (!next) setEngraveDepthEntered(false)
                          }}>{tx('NewOperationModalBody.Depth_from_line_width', { p1: engrave.useWidthForDepth ? tx('NewOperationModalBody.Census_on') : '' })}</button>
                      </div>
                      {engrave.useWidthForDepth && (
                        <NumberField label={tx('NewOperationModalBody.Target_line_width')} unit="mm" units={displayUnits}
                          value={engrave.targetLineWidth} min={0.05} max={20} step={0.1}
                          onChange={v => setEngrave(e => ({ ...e, targetLineWidth: v }))}
                        />
                      )}
                      {engrave.useWidthForDepth && engraveHeightPreview.state === 'resolved' ? (
                        <div className="op-pass-summary">
                          <span>{tx('NewOperationModalBody.width_resolver_depth', { p1: selectedTool?.angleFromAxisDeg !== undefined
                              ? tx('NewOperationModalBody.deg_included_deg_side', { p1: selectedTool.angleFromAxisDeg * 2, p2: selectedTool.angleFromAxisDeg })
                              : '', p2: fmtDim(engrave.targetLineWidth, displayUnits), p3: unitLabel(displayUnits), p4: fmtDim(
                              engraveHeightPreview.plan.machining.materialStart.wcsMm -
                                (resolvedPlanTargetEndWcs(engraveHeightPreview.plan) ??
                                  engraveHeightPreview.plan.machining.materialStart.wcsMm),
                              displayUnits,
                            ), p5: unitLabel(displayUnits), p6: selectedTool?.tipDiameter !== undefined
                              ? tx('NewOperationModalBody.including_tip_flat', { p1: fmtDim(selectedTool.tipDiameter, displayUnits), p2: unitLabel(displayUnits) })
                              : '' })}</span>
                        </div>
                      ) : engrave.useWidthForDepth && engraveHeightPreview.state === 'error' ? (
                        <span className="op-hint op-hint-warn">
                          {engraveHeightPreview.message}
                        </span>
                      ) : null}
                    </>
                  )}

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Depth_of_cut')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stepdown')} unit="mm" units={displayUnits}
                    value={passes.stepdown} min={0.01} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepdown: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Axial_offset')} unit="mm" units={displayUnits}
                    value={engrave.axialOffset} min={-50} max={50} step={0.05}
                    onChange={v => setEngrave(e => ({ ...e, axialOffset: v }))}
                  />

                  {/* Advanced (clutter P6): curve filter, side offset, travel
                      direction and lead arcs behind the standard disclosure.
                      Placement only - no behavior or default changes. */}
                  <DisclosureSection
                    title={tx('NewOperationModalBody.Advanced')}
                    summary={tx('NewOperationModalBody.Advanced_curve_summary')}
                    testId="disclosure-passes-advanced"
                  >
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Curves_to_follow')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${engrave.includeOpen ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, includeOpen: !e.includeOpen }))}>{tx('NewOperationModalBody.Open_paths', { p1: engrave.includeOpen ? '✓' : '' })}</button>
                    <button className={`op-toggle-btn ${engrave.includeClosed ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, includeClosed: !e.includeClosed }))}>{tx('NewOperationModalBody.Closed_loops', { p1: engrave.includeClosed ? '✓' : '' })}</button>
                  </div>

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Tool_position')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${engrave.side === 'center' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, side: 'center' }))}>{tx('NewOperationModalBody.On_the_line')}</button>
                    <button className={`op-toggle-btn ${engrave.side === 'left' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, side: 'left' }))}>{tx('NewOperationModalBody.Left')}</button>
                    <button className={`op-toggle-btn ${engrave.side === 'right' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, side: 'right' }))}>{tx('NewOperationModalBody.Right')}</button>
                  </div>
                  {engrave.side !== 'center' && (
                    <NumberField label={tx('NewOperationModalBody.Side_offset')} unit="mm" units={displayUnits}
                      value={engrave.sideOffset} min={0} max={50} step={0.1}
                      onChange={v => setEngrave(e => ({ ...e, sideOffset: v }))}
                    />
                  )}

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Direction')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${engrave.direction === 'as_drawn' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, direction: 'as_drawn' }))}>{tx('NewOperationModalBody.As_drawn')}</button>
                    <button className={`op-toggle-btn ${engrave.direction === 'climb' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, direction: 'climb' }))}>{tx('NewOperationModalBody.Climb')}</button>
                    <button className={`op-toggle-btn ${engrave.direction === 'conventional' ? 'op-toggle-active' : ''}`}
                      onClick={() => setEngrave(e => ({ ...e, direction: 'conventional' }))}>{tx('NewOperationModalBody.Conventional')}</button>
                  </div>

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Lead_in_out')}</p>
                  <NumberField label={tx('NewOperationModalBody.Lead_in_radius')} unit="mm" units={displayUnits}
                    value={linking.leadInRadius} min={0} max={50} step={0.5}
                    onChange={v => setLinking(l => ({ ...l, leadInRadius: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Lead_out_radius')} unit="mm" units={displayUnits}
                    value={linking.leadOutRadius} min={0} max={50} step={0.5}
                    onChange={v => setLinking(l => ({ ...l, leadOutRadius: v }))}
                  />
                  </DisclosureSection>
                </>
              )}

              {/* ── Face passes ── */}
              {isFace && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Strategy')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${face.pattern === 'zigzag' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, pattern: 'zigzag', direction: 'both_ways' }))}>{tx('NewOperationModalBody.Zigzag')}</button>
                    <button className={`op-toggle-btn ${face.pattern === 'one_way' && face.direction === 'climb' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, pattern: 'one_way', direction: 'climb' }))}>{tx('NewOperationModalBody.One_way_climb')}</button>
                    <button className={`op-toggle-btn ${face.pattern === 'one_way' && face.direction === 'conventional' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, pattern: 'one_way', direction: 'conventional' }))}>{tx('NewOperationModalBody.One_way_conv')}</button>
                    <button className={`op-toggle-btn ${face.pattern === 'offset' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, pattern: 'offset', direction: 'climb' }))}>{tx('NewOperationModalBody.Offset')}</button>
                    <button data-tooltip={tx('NewOperationModalBody.Spiral_help')} aria-pressed={face.pattern === 'spiral'} className={`op-toggle-btn ${face.pattern === 'spiral' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, pattern: 'spiral', direction: 'climb' }))}>{tx('NewOperationModalBody.Inward_spiral')}</button>
                  </div>

                  <NumberField label={tx('NewOperationModalBody.Stepover')} unit="mm" units={displayUnits}
                    value={passes.stepover} min={FACE_STEPOVER_BOUNDS.min} max={faceToolDiameterCap(selectedTool)} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepover: v }))}
                  />

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Depth')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stepdown')} unit="mm" units={displayUnits}
                    value={passes.stepdown} min={FACE_STEPDOWN_BOUNDS.min} max={FACE_STEPDOWN_BOUNDS.max} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepdown: v }))}
                  />

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Stock_to_leave')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Radial')} unit="mm" units={displayUnits}
                    value={passes.stockToLeave} min={FACE_RADIAL_STOCK_BOUNDS.min} max={faceToolDiameterCap(selectedTool)} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, stockToLeave: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Axial')} unit="mm" units={displayUnits}
                    value={passes.floorStockToLeave ?? 0} min={0} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, floorStockToLeave: v }))}
                  />

                  {/* Advanced (clutter P6): pass geometry tuning + containment
                      + per-level toggles behind the standard disclosure.
                      Placement only - no behavior or default changes. */}
                  <DisclosureSection
                    title={tx('NewOperationModalBody.Advanced')}
                    summary={tx('NewOperationModalBody.Advanced_pass_summary')}
                    testId="disclosure-passes-advanced"
                  >
                  <NumberField label={tx('NewOperationModalBody.Pass_angle')} unit="°"
                    value={face.passAngle} min={FACE_PASS_ANGLE_BOUNDS.min} max={FACE_PASS_ANGLE_BOUNDS.max} step={5}
                    onChange={v => setFace(f => ({ ...f, passAngle: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Pass_extension')} unit="mm" units={displayUnits}
                    value={face.passExtension} min={FACE_PASS_EXTENSION_BOUNDS.min} max={FACE_PASS_EXTENSION_BOUNDS.max} step={0.5}
                    onChange={v => setFace(f => ({ ...f, passExtension: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_offset')} unit="mm" units={displayUnits}
                    value={face.stockOffset} min={FACE_STOCK_OFFSET_BOUNDS.min} max={FACE_STOCK_OFFSET_BOUNDS.max} step={0.5}
                    onChange={v => setFace(f => ({ ...f, stockOffset: v }))}
                  />

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Boundary_containment')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${face.boundaryContainment === 'outside' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, boundaryContainment: 'outside' }))}>{tx('NewOperationModalBody.Outside')}</button>
                    <button className={`op-toggle-btn ${face.boundaryContainment === 'center' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, boundaryContainment: 'center' }))}>{tx('NewOperationModalBody.Centre')}</button>
                    <button className={`op-toggle-btn ${face.boundaryContainment === 'inside' ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, boundaryContainment: 'inside' }))}>{tx('NewOperationModalBody.Inside')}</button>
                  </div>

                  <div className="op-toggle-row" style={{ marginTop: 8 }}>
                    <button className={`op-toggle-btn ${face.bothSidesPerLevel ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, bothSidesPerLevel: !f.bothSidesPerLevel }))}>{tx('NewOperationModalBody.Alternate_direction_each_level', { p1: face.bothSidesPerLevel ? '✓' : '' })}</button>
                  </div>
                  <div className="op-toggle-row" style={{ marginTop: 8 }}>
                    <button className={`op-toggle-btn ${face.finishPass ? 'op-toggle-active' : ''}`}
                      onClick={() => setFace(f => ({ ...f, finishPass: !f.finishPass }))}>{tx('NewOperationModalBody.Finish_pass', { p1: face.finishPass ? '✓' : '' })}</button>
                  </div>

                  </DisclosureSection>
                </>
              )}

              {/* ── Chamfer passes ── */}
              {isChamfer && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Chamfer_geometry')}</p>


                  <NumberField label={tx('NewOperationModalBody.Chamfer_width')} unit="mm" units={displayUnits}
                    value={chamfer.chamferWidth} min={0.05} max={50} step={0.1}
                    onChange={v => setChamfer(c => ({ ...c, chamferWidth: v }))}
                  />

                  <NumberField label={tx('NewOperationModalBody.Tip_offset')} unit="mm" units={displayUnits}
                    value={chamfer.tipOffset} min={0} max={50} step={0.05}
                    onChange={v => setChamfer(c => ({ ...c, tipOffset: v }))}
                  />

                  {selectedTool?.angleFromAxisDeg && chamferDepthMm != null && (() => {
                    const halfAngle = toolHalfAngleRad(selectedTool.angleFromAxisDeg)
                    const tanHalf   = Math.tan(halfAngle)
                    const xyOff     = chamfer.tipOffset * tanHalf
                    return (
                      <div className="op-pass-summary">
                        <span>{tx('NewOperationModalBody.included_side_depth_total_Z_drop', { p1: selectedTool.angleFromAxisDeg * 2, p2: selectedTool.angleFromAxisDeg, p3: fmtDim(chamfer.chamferWidth, displayUnits), p4: unitLabel(displayUnits), p5: chamfer.tipOffset > 0 ? tx('NewOperationModalBody.Census_extra', { p1: fmtDim(chamfer.tipOffset, displayUnits), p2: unitLabel(displayUnits) }) : '', p6: fmtDim(chamferDepthMm, displayUnits), p7: unitLabel(displayUnits), p8: xyOff > 0 ? tx('NewOperationModalBody.XY_offset', { p1: fmtDim(xyOff, displayUnits), p2: unitLabel(displayUnits) }) : '' })}</span>
                      </div>
                    )
                  })()}

                  {modeledChamferNote && (
                    <div className="op-hint op-hint-warn" data-testid="chamfer-angle-note-passes">{tx('NewOperationModalBody.Modeled_chamfer_angle_note', {
                      p1: String(Number(modeledChamferNote.bitIncludedDeg.toFixed(1))),
                      p2: String(Number(modeledChamferNote.chamferIncludedDeg.toFixed(1))),
                      p3: `${fmtDim(modeledChamferNote.depthMm, displayUnits)} ${unitLabel(displayUnits)}`,
                      p4: `${fmtDim(modeledChamferNote.cutWidthMm, displayUnits)} ${unitLabel(displayUnits)}`,
                      p5: `${fmtDim(modeledChamferNote.modeledWidthMm, displayUnits)} ${unitLabel(displayUnits)}`,
                    })}</div>
                  )}

                  {/* Advanced (clutter P6): seam overlap behind the standard
                      disclosure. Placement only. */}
                  <DisclosureSection
                    title={tx('NewOperationModalBody.Advanced')}
                    summary={tx('NewOperationModalBody.Advanced_overlap_summary', { p1: fmtDim(chamfer.overlapMm, displayUnits, 1), p2: unitLabel(displayUnits) })}
                    testId="disclosure-passes-advanced"
                  >
                  <NumberField label={tx('NewOperationModalBody.Contour_overlap')} unit="mm" units={displayUnits}
                    value={chamfer.overlapMm} min={0} max={20} step={0.5}
                    onChange={v => setChamfer(c => ({ ...c, overlapMm: v }))}
                  />
                  </DisclosureSection>
                </>
              )}

              {/* ── Drill passes ── */}
              {isBore && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Bore_milling')}</p>
                  <div className="op-field-row" data-testid="bore-target-diameter">
                    <span className="op-field-label">{tx('NewOperationModalBody.Target_diameter')}</span>
                    <div className="op-field-right">
                      <div className="op-field-input-row">
                        <OptionalNumericInput
                          className="op-field-input"
                          value={bore.targetDiameter}
                          min={0.1}
                          step={0.1}
                          units={displayUnits}
                          placeholder={tx('NewOperationModalBody.auto')}
                          tooltip={tx('NewOperationModalBody.Auto_selected_circle_or_STEP_cylinder_diameter')}
                          onChange={v => setBore(b => ({ ...b, targetDiameter: v }))}
                        />
                        <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                      </div>
                    </div>
                  </div>
                  <NumberField label={tx('NewOperationModalBody.Maximum_stepdown')} unit="mm" units={displayUnits}
                    value={passes.stepdown} min={0.01} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepdown: v }))} />
                  <NumberField label={tx('NewOperationModalBody.Radial_stepover')} unit="mm" units={displayUnits}
                    value={passes.stepover} min={0.01}
                    max={selectedTool ? selectedTool.diameter * 0.8 : undefined} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, stepover: v }))} />
                  <NumberField label={tx('NewOperationModalBody.Radial_stock_to_leave')} unit="mm" units={displayUnits}
                    value={passes.stockToLeave} min={0} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, stockToLeave: v }))} />
                  <NumberField label={tx('NewOperationModalBody.Finish_passes')} unit=""
                    value={passes.finishPasses} min={0} max={10} step={1}
                    onChange={v => setPasses(p => ({ ...p, finishPasses: Math.round(v) }))} />
                  <NumberField label={tx('NewOperationModalBody.Spring_passes')} unit=""
                    value={passes.springPasses} min={0} max={10} step={1}
                    onChange={v => setPasses(p => ({ ...p, springPasses: Math.round(v) }))} />
                  <NumberField label={tx('NewOperationModalBody.Overlap')} unit="mm" units={displayUnits}
                    value={passes.overlapMm ?? 0} min={0} step={0.1}
                    onChange={v => setPasses(p => ({ ...p, overlapMm: v }))} />
                  {heightRepairRequired && bore.perBoreDepth !== undefined && (
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={bore.perBoreDepth}
                        onChange={e => setBore(b => ({ ...b, perBoreDepth: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Per_bore_depth_from_STEP_model')}</span>
                    </label>
                  )}
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Milling_direction')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${bore.direction === 'climb' ? 'op-toggle-active' : ''}`}
                      onClick={() => setBore(b => ({ ...b, direction: 'climb' }))}>{tx('NewOperationModalBody.Climb')}</button>
                    <button className={`op-toggle-btn ${bore.direction === 'conventional' ? 'op-toggle-active' : ''}`}
                      onClick={() => setBore(b => ({ ...b, direction: 'conventional' }))}>{tx('NewOperationModalBody.Conventional')}</button>
                  </div>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Bore_ordering')}</p>
                  <select className="mform-select" value={bore.sortStrategy}
                    onChange={e => setBore(b => ({ ...b, sortStrategy: e.target.value as BoreParams['sortStrategy'] }))}>
                    <option value="nearest_neighbor">{tx('NewOperationModalBody.Nearest_neighbor')}</option>
                    <option value="by_x">{tx('NewOperationModalBody.By_X')}</option>
                    <option value="by_y">{tx('NewOperationModalBody.By_Y')}</option>
                    <option value="none">{tx('NewOperationModalBody.As_selected')}</option>
                  </select>
                </>
              )}

              {isDrill && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Drilling_cycle')}</p>
                  <div className="op-toggle-row" style={{ flexWrap: 'wrap' }}>
                    {(['simple', 'peck', 'chip_break', 'dwell'] as const).map(c => (
                      <button
                        key={c}
                        className={`op-toggle-btn ${drill.cycleType === c ? 'op-toggle-active' : ''}`}
                        onClick={() => setDrill(d => ({ ...d, cycleType: c }))}
                      >
                        {c === 'simple' ? tx('NewOperationModalBody.Simple_G81') : c === 'peck' ? tx('NewOperationModalBody.Peck_G83') : c === 'chip_break' ? tx('NewOperationModalBody.Chip_break_G73') : tx('NewOperationModalBody.Dwell_G82')}
                      </button>
                    ))}
                  </div>

                  {(drill.cycleType === 'peck' || drill.cycleType === 'chip_break') && (
                    <NumberField label={tx('NewOperationModalBody.Peck_depth')} unit="mm" units={displayUnits}
                      value={drill.peckDepth} min={0.1} step={0.5}
                      onChange={v => setDrill(d => ({ ...d, peckDepth: v }))}
                    />
                  )}

                  {drill.cycleType === 'chip_break' && (
                    <NumberField label={tx('NewOperationModalBody.Chip_break_retract')} unit="mm" units={displayUnits}
                      value={drill.chipBreakRetract} min={0.1} max={10} step={0.25}
                      onChange={v => setDrill(d => ({ ...d, chipBreakRetract: v }))}
                    />
                  )}

                  {drill.cycleType === 'dwell' && (
                    <NumberField label={tx('NewOperationModalBody.Dwell_time')} unit="s"
                      value={drill.dwell} min={0} step={0.1}
                      onChange={v => setDrill(d => ({ ...d, dwell: v }))}
                    />
                  )}

                  {/* Per-hole depth: only meaningful for ops created from B-rep
                      detected holes — the flag is set (true) in that flow and
                      stays undefined otherwise. */}
                  {heightRepairRequired && drill.perHoleDepth !== undefined && (
                    <div className="op-check-section" style={{ marginTop: 14 }}>
                      <label className="op-check-label op-check-label-lg">
                        <input type="checkbox" checked={drill.perHoleDepth}
                          onChange={e => setDrill(d => ({ ...d, perHoleDepth: e.target.checked }))} />
                        <span>{tx('NewOperationModalBody.Per_hole_depth_from_model')}</span>
                      </label>
                    </div>
                  )}

                  {/* Per-hole depths: a manual BOTTOM-Z override per selected
                      hole. Works for ANY drill op with selected holes (B-rep OR
                      DXF/sketch), independent of the B-rep-only "Per-hole depth
                      (from model)" checkbox above. Empty field == auto (the
                      op-level bottom plane, or the model-detected bottom when
                      that checkbox is on); typing sets
                      perHoleDepthOverrides[loopId] (WCS-relative mm, same sign
                      as the op bottom-height field); clearing removes the key.
                      The map is omitted entirely when empty so no-override ops
                      stay byte-identical in saved files. */}
                  {drillHoleRows.length > 0 && (
                    <div className="op-check-section" style={{ marginTop: 14 }}>
                      <p className="op-section-label" style={{ marginTop: 0 }}>{tx('NewOperationModalBody.Per_hole_depths')}</p>
                      <div className="op-perhole-table" data-testid="drill-perhole-table">
                        <div className="op-perhole-row op-perhole-head">
                          <span className="op-perhole-cell op-perhole-label">{tx('NewOperationModalBody.Hole')}</span>
                          <span className="op-perhole-cell">X</span>
                          <span className="op-perhole-cell">Y</span>
                          <span className="op-perhole-cell">{tx('NewOperationModalBody.symbol_7')}</span>
                          <span className="op-perhole-cell op-perhole-depth">{tx('NewOperationModalBody.Depth_2', { p1: unitLabel(displayUnits) })}</span>
                        </div>
                        {drillHoleRows.map(row => {
                          const override = drill.perHoleDepthOverrides?.[row.id]
                          // When "Per-hole depth (from model)" is on AND this hole
                          // has a detected bottom, the auto value is the RESOLVED
                          // cutter-center endpoint from the modal's own Smart Height
                          // plan (drill point + breakthrough allowances included) —
                          // the same value the toolpath uses. Falls back to the raw
                          // detected floor only when the plan has not resolved a
                          // matching feature yet; the op-level bottom height is the
                          // last resort.
                          const resolvedRel = drill.perHoleDepth ? drillResolvedWcsRel[row.id] : undefined
                          const detectedRel = resolvedRel === undefined && drill.perHoleDepth
                            ? drillDetectedWcsRel[row.id]
                            : undefined
                          const autoStr = resolvedRel !== undefined
                            ? fmtDim(resolvedRel, displayUnits)
                            : detectedRel !== undefined
                            ? fmtDim(detectedRel, displayUnits)
                            : fmtDim(heights.bottomHeight, displayUnits)
                          return (
                            <div key={row.id} className="op-perhole-row" data-testid="drill-perhole-row">
                              <span className="op-perhole-cell op-perhole-label">
                                <button
                                  type="button"
                                  className="op-perhole-review-btn"
                                  data-testid="drill-perhole-review-link"
                                  data-tooltip={tx('NewOperationModalBody.Highlight_hole_in_the_viewport', { p1: row.index })}
                                  onClick={() => startHoleReview(row.id)}
                                >{tx('NewOperationModalBody.symbol')}{row.index}</button>
                              </span>
                              <span className="op-perhole-cell">{fmtDim(row.cx, displayUnits)}</span>
                              <span className="op-perhole-cell">{fmtDim(row.cy, displayUnits)}</span>
                              <span className="op-perhole-cell">{fmtDim(row.diameterMm, displayUnits)}</span>
                              <span className="op-perhole-cell op-perhole-depth">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  onFocus={(e) => e.currentTarget.select()}
                                  className="op-field-input op-perhole-input"
                                  data-testid="drill-perhole-input"
                                  aria-label={tx('NewOperationModalBody.Hole_bottom_depth', { p1: row.index })}
                                  value={override !== undefined ? fmtDim(override, displayUnits) : ''}
                                  placeholder={tx('NewOperationModalBody.auto')}
                                  data-tooltip={tx('NewOperationModalBody.auto_2', { p1: autoStr })}
                                  onChange={e => {
                                    const raw = e.target.value.trim()
                                    setDrill(prev => {
                                      const next = { ...(prev.perHoleDepthOverrides ?? {}) }
                                      if (raw === '') {
                                        // Clear -> back to auto: drop the key.
                                        delete next[row.id]
                                      } else {
                                        const mm = parseDimToMm(raw, displayUnits)
                                        // Ignore unparseable garbage (keep the field
                                        // editable mid-type); only commit real numbers.
                                        if (Number.isNaN(mm)) return prev
                                        next[row.id] = mm
                                      }
                                      // Omit the map entirely when empty so a
                                      // no-override op is byte-identical (field
                                      // absent in saved files).
                                      return Object.keys(next).length === 0
                                        ? { ...prev, perHoleDepthOverrides: undefined }
                                        : { ...prev, perHoleDepthOverrides: next }
                                    })
                                  }}
                                />
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Advanced (clutter P6): hole-ordering strategy behind the
                      standard disclosure. Placement only. The per-hole depth
                      table above stays at rest - it IS drill's depth control. */}
                  <DisclosureSection
                    title={tx('NewOperationModalBody.Advanced')}
                    summary={tx('NewOperationModalBody.Advanced_hole_ordering_summary', { p1:
                      drill.sortStrategy === 'by_x' ? tx('NewOperationModalBody.Summary_by_X')
                      : drill.sortStrategy === 'by_y' ? tx('NewOperationModalBody.Summary_by_Y')
                      : drill.sortStrategy === 'none' ? tx('NewOperationModalBody.Summary_as_selected')
                      : tx('NewOperationModalBody.Summary_nearest_neighbour') })}
                    testId="disclosure-passes-advanced"
                  >
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Hole_ordering')}</p>
                  <div className="op-toggle-row">
                    {([
                      { v: 'nearest_neighbor', get label() { return tx('NewOperationModalBody.Nearest_neighbour') } },
                      { v: 'by_x',             get label() { return tx('NewOperationModalBody.By_X') } },
                      { v: 'by_y',             get label() { return tx('NewOperationModalBody.By_Y') } },
                      { v: 'none',             get label() { return tx('NewOperationModalBody.As_selected') } },
                    ] as const).map(({ v, label }) => (
                      <button
                        key={v}
                        className={`op-toggle-btn ${drill.sortStrategy === v ? 'op-toggle-active' : ''}`}
                        onClick={() => setDrill(d => ({ ...d, sortStrategy: v }))}
                      >{label}</button>
                    ))}
                  </div>
                  </DisclosureSection>
                </>
              )}

              {/* ── Thread Mill passes ── */}
              {isThreadMill && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Thread_geometry')}</p>
                  {/* Source badge: cylinder-pick = auto-inferred; loop/manual = set by hand. */}
                  <div
                    data-testid="thread-source-badge"
                    className="op-hint"
                    style={{
                      marginBottom: 10,
                      padding: '6px 10px',
                      borderRadius: 4,
                      fontWeight: 600,
                      border: '1px solid',
                      // MODAL-CONTRAST: both were raw dark hexes on a near-
                      // transparent tint of themselves -- 2.68:1/3.17:1,
                      // failed WCAG text (4.5:1). Swapped onto the app's
                      // existing badge-success/badge-warning recipes
                      // (5.20:1 / 6.34:1).
                      ...(threadMill.geometrySource === 'cylinder'
                        ? { color: 'var(--accent-green)', borderColor: 'rgba(76, 175, 80, .35)', background: 'rgba(76, 175, 80, .12)' }
                        : { color: 'var(--accent-amber)', borderColor: 'rgba(245, 197, 66, .35)', background: 'rgba(245, 197, 66, .12)' }),
                    }}
                  >
                    {threadMill.geometrySource === 'cylinder'
                      ? tx('NewOperationModalBody.Auto_from_selected_cylinder_face')
                      : tx('NewOperationModalBody.Manual_set_kind_direction_for_this_circle')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                    <label className="op-field-label">{tx('NewOperationModalBody.Thread_size_preset')}</label>
                    <select
                      className="mform-select"
                      data-testid="thread-size-preset"
                      defaultValue=""
                      onChange={e => {
                        const preset = findThreadPreset(e.target.value)
                        if (preset) {
                          setThreadMill(t => ({ ...t, majorDiameter: preset.majorDiameter, pitch: preset.pitch, tpi: preset.tpi }))
                        }
                      }}
                    >
                      <option value="">{tx('NewOperationModalBody.Custom')}</option>
                      {THREAD_PRESETS.map(p => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <NumberField label={tx('NewOperationModalBody.Major_diameter')} unit="mm" units={displayUnits}
                    value={threadMill.majorDiameter} min={0.5} max={200} step={0.5}
                    onChange={v => setThreadMill(t => ({ ...t, majorDiameter: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Pitch')} unit="mm" units={displayUnits}
                    value={threadMill.pitch} min={0.1} max={20} step={0.1}
                    onChange={v => setThreadMill(t => ({ ...t, pitch: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.TPI_optional')} unit=""
                    value={threadMill.tpi ?? 0} min={0} max={80} step={1}
                    onChange={v => setThreadMill(t => ({ ...t, tpi: v > 0 ? v : undefined }))}
                  />

                  {threadMill.geometrySource === 'cylinder' ? (
                    /* Cylinder pick INFERRED the kind: show it read-only and tuck the
                       editable select behind an Advanced override (still functional,
                       same data-testid). */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                      <label className="op-field-label">{tx('NewOperationModalBody.Thread_kind')}</label>
                      <span data-testid="thread-detected-kind" className="op-hint" style={{ fontWeight: 600, marginBottom: 0 }}>{tx('NewOperationModalBody.Detected', { p1: threadMill.threadKind === 'internal' ? tx('NewOperationModalBody.Internal_bore') : tx('NewOperationModalBody.External_boss') })}</span>
                      <details style={{ marginTop: 4 }}>
                        <summary className="op-hint" style={{ cursor: 'pointer', marginBottom: 0 }}>{tx('NewOperationModalBody.Advanced_override_detected_type')}</summary>
                        <select
                          className="mform-select"
                          data-testid="thread-kind"
                          value={threadMill.threadKind}
                          onChange={e => setThreadMill(t => ({ ...t, threadKind: e.target.value as ThreadMillParams['threadKind'] }))}
                          style={{ marginTop: 6 }}
                        >
                          <option value="internal">{tx('NewOperationModalBody.Internal')}</option>
                          <option value="external">{tx('NewOperationModalBody.External')}</option>
                        </select>
                      </details>
                    </div>
                  ) : (
                    /* Loop/manual: a 2D circle can't be inferred, so kind + size are
                       set by hand. Keep the select prominent. */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                      <label className="op-field-label">{tx('NewOperationModalBody.Thread_kind')}</label>
                      <select
                        className="mform-select"
                        data-testid="thread-kind"
                        value={threadMill.threadKind}
                        onChange={e => setThreadMill(t => ({ ...t, threadKind: e.target.value as ThreadMillParams['threadKind'] }))}
                      >
                        <option value="internal">{tx('NewOperationModalBody.Internal')}</option>
                        <option value="external">{tx('NewOperationModalBody.External')}</option>
                      </select>
                    </div>
                  )}

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Passes')}</p>
                  <NumberField label={tx('NewOperationModalBody.Radial_stepover')} unit="mm" units={displayUnits}
                    value={threadMill.radialStepover ?? 1} min={0.01} step={0.05}
                    onChange={v => setThreadMill(t => ({ ...t, radialStepover: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Spring_passes')} unit=""
                    value={threadMill.springPasses} min={0} step={1}
                    onChange={v => setThreadMill(t => ({ ...t, springPasses: Math.max(0, Math.round(v)) }))}
                  />

                  {/* Advanced (clutter P6): handedness, cut direction, lead
                      arcs and compensation behind the standard disclosure.
                      Placement only - no behavior or default changes. */}
                  <DisclosureSection
                    title={tx('NewOperationModalBody.Advanced')}
                    summary={tx('NewOperationModalBody.Advanced_thread_summary', { p1: threadMill.handedness === 'left' ? tx('NewOperationModalBody.Summary_left_hand') : tx('NewOperationModalBody.Summary_right_hand'), p2: tx(`NewOperationModalBody.Summary_direction_${threadMill.cutDirection}`), p3: threadMill.leadInOut === 'arc' ? tx('NewOperationModalBody.Summary_tangent_arc') : tx('NewOperationModalBody.Summary_no_lead') })}
                    testId="disclosure-passes-advanced"
                  >
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Handedness')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${threadMill.handedness === 'right' ? 'op-toggle-active' : ''}`}
                      onClick={() => setThreadMill(t => ({ ...t, handedness: 'right' }))}>{tx('NewOperationModalBody.Right_hand')}</button>
                    <button className={`op-toggle-btn ${threadMill.handedness === 'left' ? 'op-toggle-active' : ''}`}
                      onClick={() => setThreadMill(t => ({ ...t, handedness: 'left' }))}>{tx('NewOperationModalBody.Left_hand')}</button>
                  </div>

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Cut_direction')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${threadMill.cutDirection === 'climb' ? 'op-toggle-active' : ''}`}
                      onClick={() => setThreadMill(t => ({ ...t, cutDirection: 'climb' }))}>{tx('NewOperationModalBody.Climb')}</button>
                    <button className={`op-toggle-btn ${threadMill.cutDirection === 'conventional' ? 'op-toggle-active' : ''}`}
                      onClick={() => setThreadMill(t => ({ ...t, cutDirection: 'conventional' }))}>{tx('NewOperationModalBody.Conventional')}</button>
                  </div>

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Lead_in_out_2')}</p>
                  <div className="op-toggle-row">
                    <button className={`op-toggle-btn ${threadMill.leadInOut === 'arc' ? 'op-toggle-active' : ''}`}
                      onClick={() => setThreadMill(t => ({ ...t, leadInOut: 'arc' }))}>{tx('NewOperationModalBody.Tangent_arc')}</button>
                    <button className={`op-toggle-btn ${threadMill.leadInOut === 'none' ? 'op-toggle-active' : ''}`}
                      onClick={() => setThreadMill(t => ({ ...t, leadInOut: 'none' }))}>{tx('NewOperationModalBody.None')}</button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 14 }}>
                    <label className="op-field-label">{tx('NewOperationModalBody.Compensation')}</label>
                    <select className="mform-select" data-testid="thread-compensation" value="computer" disabled>
                      <option value="computer">{tx('NewOperationModalBody.Computer')}</option>
                    </select>
                  </div>
                  </DisclosureSection>
                </>
              )}

              {/* ── Adaptive Clearing passes ── */}
              {isAdaptive && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Load')}</p>
                  <NumberField label={tx('NewOperationModalBody.Optimal_load_stepover')} unit="mm" units={displayUnits}
                    value={passes.stepover} min={0.1} max={selectedTool ? selectedTool.diameter : undefined} step={0.1}
                    onChange={v => setPasses(p => ({ ...p, stepover: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Tolerance')} unit="mm" units={displayUnits}
                    value={adaptive.tolerance ?? 0.05} min={0.005} max={0.5} step={0.005}
                    onChange={v => setAdaptive(a => ({ ...a, tolerance: v }))}
                  />

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Depth_of_cut')}</p>
                  <NumberField label={tx('NewOperationModalBody.Maximum_stepdown')} unit="mm" units={displayUnits}
                    value={passes.stepdown} min={0.01} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepdown: v }))}
                  />

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Stock_to_leave')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Radial')} unit="mm" units={displayUnits}
                    value={passes.stockToLeave} min={0} max={selectedTool ? selectedTool.diameter : undefined} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, stockToLeave: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Axial')} unit="mm" units={displayUnits}
                    value={passes.floorStockToLeave ?? 0} min={0} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, floorStockToLeave: v }))}
                  />
                  <label className="op-check-label">
                    <input
                      type="checkbox"
                      checked={adaptive.floorFinish ?? false}
                      onChange={e => setAdaptive(a => ({ ...a, floorFinish: e.target.checked }))}
                    />
                    <span>{tx('NewOperationModalBody.Floor_finish_pass')}</span>
                  </label>
                </>
              )}

              {/* ── Contour passes ── (catch-all: every op NOT handled by a
                  block above. parallel_3d has its OWN block above and reads none
                  of stepdown/stock-to-leave/strategy/spring/overlap, so it must
                  be excluded here or those 2.5D fields leak in as dead carryovers.) */}
              {!isPocket && !isDrill && !isBore && !isThreadMill && !isChamfer && !isFace && !isEngrave && !isVCarve && !isAdaptive && !isParallel3d && !isWaterline3d && !isSteepShallow3d && !isScallop3d && !isPencil3d && !isAdaptive3d && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Depth_of_cut')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stepdown')} unit="mm" units={displayUnits}
                    value={passes.stepdown} min={0.01} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepdown: v }))}
                  />
                  {selectedTool && (
                    <span className="op-hint op-hint-warn">{tx('NewOperationModalBody.Max_safe_stepdown_tool_flute_length', { p1: fmtDim(selectedTool.fluteLength, displayUnits), p2: unitLabel(displayUnits) })}</span>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                    <label className="op-field-label">{tx('NewOperationModalBody.Cutting_strategy')}</label>
                    <select
                      className="mform-select"
                      data-testid="contour-cutting-strategy"
                      value={contourMode}
                      onChange={e => {
                        const next = e.target.value as ContourCuttingStrategy
                        setContourMode(next)
                        // Roughing strategies leave stock on the wall — seed a REAL
                        // 0.3 mm radial default into state (only when currently 0/unset,
                        // so a user-entered value is never stomped). This is a real
                        // state write, NOT a display fallback.
                        if (next !== 'cut_at_geometry')
                          setPasses(p => (p.stockToLeave > 0 ? p : { ...p, stockToLeave: 0.3 }))
                      }}
                    >
                      <option value="cut_at_geometry">{tx('NewOperationModalBody.Cut_at_the_geometry_no_roughing')}</option>
                      <option value="roughing_only">{tx('NewOperationModalBody.Roughing_only_leave_stock_on_the_wall')}</option>
                      <option value="rough_finish_each">{tx('NewOperationModalBody.Rough_finish_each_stepdown')}</option>
                      <option value="rough_finish_final">{tx('NewOperationModalBody.Rough_finish_at_final_depth')}</option>
                    </select>
                  </div>
                  {/* WO-2289: how the rough pass is traced; only when there is roughing */}
                  {contourPathType === 'closed' && contourShowsStockToLeave && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                      <label className="op-field-label">{tx('NewOperationModalBody.Roughing_style')}</label>
                      <select
                        className="mform-select"
                        data-testid="contour-roughing-style"
                        value={contour.roughingStyle ?? 'offset'}
                        onChange={e => setContour(c => ({ ...c, roughingStyle: e.target.value as ContourRoughingStyle }))}
                        data-tooltip={tx('NewOperationModalBody.Offset_cuts_one_loop_per_stepdown_Trochoidal_cuts_a')}
                      >
                        {(Object.keys(CONTOUR_ROUGHING_STYLE_LABELS) as ContourRoughingStyle[]).map(style => (
                          <option key={style} value={style}>{tx(`choices.CONTOUR_ROUGHING_STYLE_LABELS.${style}`)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {contourPathType === 'closed' && contourShowsStockToLeave
                    && contour.roughingStyle === 'trochoidal' && selectedTool && (() => {
                    const troch = resolveTrochoidalGeometry(
                      selectedTool.diameter, contour.trochoidalWidth, contour.trochoidalAdvance)
                    const limits = trochoidalFieldLimits(selectedTool.diameter)
                    return (
                      <>
                        <NumberField label={tx('NewOperationModalBody.Channel_width')} unit="mm" units={displayUnits}
                          value={troch.width} min={limits.width.min} max={limits.width.max} step={0.5}
                          onChange={v => setContour(c => ({ ...c, trochoidalWidth: v }))}
                        />
                        <NumberField label={tx('NewOperationModalBody.Advance_per_orbit')} unit="mm" units={displayUnits}
                          value={troch.advance} min={limits.advance.min} max={limits.advance.max} step={0.1}
                          onChange={v => setContour(c => ({ ...c, trochoidalAdvance: v }))}
                        />
                      </>
                    )
                  })()}
                  {contourShowsStockToLeave && (
                    <>
                      <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Stock_to_leave')}</p>
                      <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Radial')} unit="mm" units={displayUnits}
                        value={passes.stockToLeave} min={0} step={0.05}
                        onChange={v => setPasses(p => ({ ...p, stockToLeave: v }))}
                      />
                      <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Axial')} unit="mm" units={displayUnits}
                        value={passes.floorStockToLeave ?? 0} min={0} step={0.05}
                        onChange={v => setPasses(p => ({ ...p, floorStockToLeave: v }))}
                      />
                    </>
                  )}
                  {contourShowsFinishPasses && (
                    <NumberField label={tx('NewOperationModalBody.Finish_passes')} unit=""
                      value={passes.finishPasses} min={1} step={1}
                      onChange={v => setPasses(p => ({ ...p, finishPasses: Math.round(v) }))}
                    />
                  )}

                  {/* Advanced (clutter P6): spring passes + seam overlap move
                      behind the standard disclosure. Placement only. */}
                  <DisclosureSection
                    title={tx('NewOperationModalBody.Advanced')}
                    summary={contourPathType === 'open'
                      ? tx('NewOperationModalBody.Advanced_spring_summary', { p1: passes.springPasses })
                      : tx('NewOperationModalBody.Advanced_spring_overlap_summary', { p1: passes.springPasses, p2: fmtDim(passes.overlapMm ?? 0, displayUnits, 1), p3: unitLabel(displayUnits) })}
                    testId="disclosure-passes-advanced"
                  >
                  <NumberField label={tx('NewOperationModalBody.Spring_passes')} unit=""
                    value={passes.springPasses} min={0} step={1}
                    onChange={v => setPasses(p => ({ ...p, springPasses: Math.round(v) }))}
                  />

                  {contourPathType === 'closed' && (
                  <NumberField label={tx('NewOperationModalBody.Contour_overlap')} unit="mm" units={displayUnits}
                    value={passes.overlapMm ?? 0} min={0} max={50} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, overlapMm: v }))}
                  />
                  )}

                  {/* WO-2287: inside-corner relief, sized to this operation's tool */}
                  {contourPathType === 'closed' && (
                  <>
                  <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Corner_relief')}</p>
                  <select
                    className="mform-select"
                    data-testid="contour-corner-relief"
                    value={contour.cornerRelief ?? 'none'}
                    onChange={e => setContour(c => ({ ...c, cornerRelief: e.target.value as CornerReliefStyle }))}
                    data-tooltip={tx('NewOperationModalBody.Cut_into_each_inside_corner_a_round_cutter_leaves')}
                  >
                    {CORNER_RELIEF_STYLES.map(style => (
                      <option key={style} value={style}>{tx(`choices.CORNER_RELIEF_LABELS.${style}`)}</option>
                    ))}
                  </select>
                  {/* WO-2317: Gentle corner - the relief cut in small orbits under a set width */}
                  {(contour.cornerRelief ?? 'none') !== 'none' && (
                  <div className="op-check-section" style={{ marginTop: 6 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" data-testid="contour-corner-relief-gentle"
                        checked={contour.cornerReliefGentle === true}
                        onChange={e => setContour(x => ({ ...x, cornerReliefGentle: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Gentle_corner_small_orbits')}</span>
                    </label>
                  </div>
                  )}
                  {(contour.cornerRelief ?? 'none') !== 'none' && contour.cornerReliefGentle === true && selectedTool && (
                  <NumberField label={tx('NewOperationModalBody.Max_engagement')} unit="mm" units={displayUnits}
                    value={resolveGentleEngagement(selectedTool.diameter, contour.cornerReliefEngagement)}
                    min={gentleEngagementLimits(selectedTool.diameter).min} max={gentleEngagementLimits(selectedTool.diameter).max} step={0.1}
                    onChange={v => setContour(x => ({ ...x, cornerReliefEngagement: v }))}
                  />
                  )}
                  </>
                  )}
                  </DisclosureSection>

                  <div className="op-pass-summary">
                    <span>
                      {effStockToLeave > 0
                        ? tx('NewOperationModalBody.roughing_pass_wall', { p1: estPasses, p2: estPasses !== 1 ? tx('NewOperationModalBody.Census_es') : '', p3: fmtDim(effStockToLeave, displayUnits), p4: unitLabel(displayUnits) })
                        : tx('NewOperationModalBody.pass_to_depth', { p1: estPasses, p2: estPasses !== 1 ? tx('NewOperationModalBody.Census_es') : '' })}
                      {(contourMode === 'rough_finish_each' || contourMode === 'rough_finish_final') && effFinishPasses > 0
                        ? tx('NewOperationModalBody.Census_finish', { p1: effFinishPasses, p2: contourMode === 'rough_finish_each' ? tx('NewOperationModalBody.each_stepdown') : '' }) : ''}
                      {passes.springPasses > 0 ? tx('NewOperationModalBody.Census_spring', { p1: passes.springPasses }) : ''}
                    </span>
                  </div>
                </>
              )}

              {/* ── Pocket passes ── */}
              {isPocket && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Depth_of_cut')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stepdown')} unit="mm" units={displayUnits}
                    value={passes.stepdown} min={0.01} step={0.5}
                    onChange={v => setPasses(p => ({ ...p, stepdown: v }))}
                  />
                  {selectedTool && (
                    <span className="op-hint op-hint-warn">{tx('NewOperationModalBody.Max_safe_stepdown_tool_flute_length', { p1: fmtDim(selectedTool.fluteLength, displayUnits), p2: unitLabel(displayUnits) })}</span>
                  )}

                  <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Pocket_fill')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stepover')} unit="mm" units={displayUnits}
                    value={passes.stepover} min={0.1} step={0.5}
                    max={isPocket && selectedTool ? selectedTool.diameter : undefined}
                    onChange={v => setPasses(p => ({ ...p, stepover: v }))}
                  />

                  {/* Advanced (clutter P6): fill strategy, ring transitions,
                      pocket ordering and the finish-contour pass move behind
                      the standard disclosure. Placement only - no field's
                      behavior or default changes. Core fields (stepdown,
                      stepover, stock to leave) stay at rest. */}
                  <DisclosureSection
                    title={tx('NewOperationModalBody.Advanced')}
                    summary={tx('NewOperationModalBody.Advanced_pocket_summary')}
                    testId="disclosure-passes-advanced"
                  >

                  {/* Fill strategy */}
                  <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Fill_strategy')}</p>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${(pocket.fillStrategy ?? 'outside_in') === 'outside_in' ? 'op-toggle-active' : ''}`}
                      onClick={() => {
                        setPocket(p => ({ ...p, fillStrategy: 'outside_in' }))
                        setLinking(l => ({
                          ...l,
                          entryType: normalizePocketEntryForFillStrategy('outside_in', l.entryType),
                        }))
                      }}
                    >{tx('NewOperationModalBody.Outside_in')}</button>
                    <button
                      className={`op-toggle-btn ${pocket.fillStrategy === 'inside_out' ? 'op-toggle-active' : ''}`}
                      onClick={() => {
                        setPocket(p => ({ ...p, fillStrategy: 'inside_out' }))
                        setLinking(l => ({
                          ...l,
                          entryType: normalizePocketEntryForFillStrategy('inside_out', l.entryType),
                        }))
                      }}
                    >{tx('NewOperationModalBody.Inside_out')}</button>
                  </div>

                  {/* WO-2291: feed where the cutter is buried full width */}
                  <NumberField label={tx('NewOperationModalBody.Slot_feed')} unit={tx('NewOperationModalBody.Percent_feed')}
                    value={pocket.slotFeedPercent ?? 100} min={1} max={100} step={5}
                    onChange={v => setPocket(p => ({ ...p, slotFeedPercent: v }))}
                  />

                  {/* Ring seam overlap + arc lead-in */}
                  <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Ring_transitions')}</p>
                  <NumberField label={tx('NewOperationModalBody.Ring_overlap')} unit="mm" units={displayUnits}
                    value={pocket.overlapMm ?? 1} min={0} max={20} step={0.5}
                    onChange={v => setPocket(p => ({ ...p, overlapMm: v }))}
                  />
                  <p className="op-section-label" style={{ marginTop: 8 }}>{tx('NewOperationModalBody.Stepover_lead_in')}</p>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${(pocket.stepoverLeadIn ?? 'none') === 'none' ? 'op-toggle-active' : ''}`}
                      onClick={() => setPocket(p => ({ ...p, stepoverLeadIn: 'none' }))}
                    >{tx('NewOperationModalBody.Direct')}</button>
                    <button
                      className={`op-toggle-btn ${pocket.stepoverLeadIn === 'arc' ? 'op-toggle-active' : ''}`}
                      onClick={() => setPocket(p => ({ ...p, stepoverLeadIn: 'arc' }))}
                    >{tx('NewOperationModalBody.Arc')}</button>
                  </div>
                  {/* WO-2296: ring corners as arcs where the ring outside takes what they skip */}
                  <div className="op-check-section" style={{ marginTop: 8 }}>
                    <label className="op-check-label">
                      <input type="checkbox" data-testid="pocket-round-ring-corners"
                        checked={pocket.roundRingCorners === true}
                        onChange={e => setPocket(p => ({ ...p, roundRingCorners: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Rounded_ring_corners')}</span>
                    </label>
                  </div>

                  {/* Multiple-pocket ordering */}
                  <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Multiple_pocket_order')}</p>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${pocket.orderStrategy === 'by_region' ? 'op-toggle-active' : ''}`}
                      onClick={() => setPocket(p => ({ ...p, orderStrategy: 'by_region' }))}
                    >{tx('NewOperationModalBody.By_region')}</button>
                    <button
                      className={`op-toggle-btn ${pocket.orderStrategy === 'by_depth' ? 'op-toggle-active' : ''}`}
                      onClick={() => setPocket(p => ({ ...p, orderStrategy: 'by_depth' }))}
                    >{tx('NewOperationModalBody.By_depth')}</button>
                  </div>

                  {/* WO-2287: inside-corner relief, sized to this operation's tool */}
                  <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Corner_relief')}</p>
                  <select
                    className="mform-select"
                    data-testid="pocket-corner-relief"
                    value={pocket.cornerRelief ?? 'none'}
                    onChange={e => setPocket(p => ({ ...p, cornerRelief: e.target.value as CornerReliefStyle }))}
                    data-tooltip={tx('NewOperationModalBody.Cut_into_each_inside_corner_a_round_cutter_leaves')}
                  >
                    {CORNER_RELIEF_STYLES.map(style => (
                      <option key={style} value={style}>{tx(`choices.CORNER_RELIEF_LABELS.${style}`)}</option>
                    ))}
                  </select>
                  {/* WO-2317: Gentle corner - the relief cut in small orbits under a set width */}
                  {(pocket.cornerRelief ?? 'none') !== 'none' && (
                  <div className="op-check-section" style={{ marginTop: 6 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" data-testid="pocket-corner-relief-gentle"
                        checked={pocket.cornerReliefGentle === true}
                        onChange={e => setPocket(x => ({ ...x, cornerReliefGentle: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Gentle_corner_small_orbits')}</span>
                    </label>
                  </div>
                  )}
                  {(pocket.cornerRelief ?? 'none') !== 'none' && pocket.cornerReliefGentle === true && selectedTool && (
                  <NumberField label={tx('NewOperationModalBody.Max_engagement')} unit="mm" units={displayUnits}
                    value={resolveGentleEngagement(selectedTool.diameter, pocket.cornerReliefEngagement)}
                    min={gentleEngagementLimits(selectedTool.diameter).min} max={gentleEngagementLimits(selectedTool.diameter).max} step={0.1}
                    onChange={v => setPocket(x => ({ ...x, cornerReliefEngagement: v }))}
                  />
                  )}

                  {/* Finish contour pass */}
                  <div className="op-check-section" style={{ marginTop: 8 }}>
                    <label className="op-check-label op-check-label-lg">
                      <input type="checkbox" checked={pocket.finishContour}
                        onChange={e => setPocket(p => ({ ...p, finishContour: e.target.checked }))} />
                      <span>{tx('NewOperationModalBody.Finish_contour_pass_on_pocket_wall')}</span>
                    </label>
                  </div>
                  {pocket.finishContour && (
                    <>
                      <NumberField label={tx('NewOperationModalBody.Finish_passes')} unit=""
                        value={passes.finishPasses} min={1} step={1}
                        onChange={v => setPasses(p => ({ ...p, finishPasses: Math.round(v) }))}
                      />
                      <NumberField label={tx('NewOperationModalBody.Spring_passes')} unit=""
                        value={passes.springPasses} min={0} step={1}
                        onChange={v => setPasses(p => ({ ...p, springPasses: Math.round(v) }))}
                      />
                      <div className="op-check-section" style={{ marginTop: 6 }}>
                        <label className="op-check-label op-check-label-lg">
                          <input type="checkbox" checked={pocket.stayDown ?? false}
                            onChange={e => setPocket(p => ({ ...p, stayDown: e.target.checked }))} />
                          <span>{tx('NewOperationModalBody.Stay_down_to_finish_contour')}</span>
                        </label>
                      </div>
                      {(pocket.stayDown ?? false) && (
                        <NumberField label={tx('NewOperationModalBody.Stay_down_lift')} unit="mm" units={displayUnits}
                          value={pocket.stayDownLift ?? 1.0} min={0.1} max={10} step={0.1}
                          onChange={v => setPocket(p => ({ ...p, stayDownLift: v }))}
                        />
                      )}
                    </>
                  )}
                  </DisclosureSection>

                  <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Stock_to_leave')}</p>
                  <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Radial')} unit="mm" units={displayUnits}
                    value={passes.stockToLeave} min={0} max={selectedTool ? selectedTool.diameter : undefined} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, stockToLeave: v }))}
                  />
                  <NumberField label={tx('NewOperationModalBody.Stock_to_Leave_Axial')} unit="mm" units={displayUnits}
                    value={passes.floorStockToLeave ?? 0} min={0} step={0.05}
                    onChange={v => setPasses(p => ({ ...p, floorStockToLeave: v }))}
                  />

                  <div className="op-pass-summary">
                    <span>{tx('NewOperationModalBody.depth_pass', { p1: estPasses, p2: estPasses !== 1 ? tx('NewOperationModalBody.Census_es') : '', p3: passes.stockToLeave > 0 ? tx('NewOperationModalBody.radial_stock', { p1: fmtDim(passes.stockToLeave, displayUnits), p2: unitLabel(displayUnits) }) : '', p4: (passes.floorStockToLeave ?? 0) > 0 ? tx('NewOperationModalBody.axial_stock', { p1: fmtDim(passes.floorStockToLeave ?? 0, displayUnits), p2: unitLabel(displayUnits) }) : '', p5: pocket.finishContour ? tx('NewOperationModalBody.finish_contour') : '' })}</span>
                  </div>
                </>
              )}

              {/* ── WO-1566: shank clearance, every 2D operation ──
                  The clearance trim (WO-1565) keeps the neck, shank and holder
                  this far from the part and the remaining stock. Same value the
                  Properties panel edits on a saved operation. */}
              {showsShankClearance && (
                <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Tool_assembly')}</p>
                  <div className="op-field-row" data-testid="op-shank-clearance">
                    <span className="op-field-label">{tx('NewOperationModalBody.Shank_clearance')}</span>
                    <div className="op-field-right">
                      <div className="op-field-input-row">
                        <NumericInput
                          className="op-field-input"
                          value={shankClearanceMm}
                          min={0}
                          step={0.05}
                          units={displayUnits}
                          onChange={setShankClearanceMm}
                          tooltip={tx('NewOperationModalBody.Clearance_kept_between_the_neck_shank_or_holder_and')}
                          ariaLabel={tx('NewOperationModalBody.Shank_clearance')}
                        />
                        <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}

            </div>
          )}

          {/* ── Heights ──────────────────────────────────────────────────── */}
          {tab === 'heights' && (
            <div className="op-tab-content op-heights-tab" style={{ display: 'grid', gap: 4 }}>
              <div data-testid="standard-height-controls" style={{ display: 'contents' }}>
                {STANDARD_HEIGHT_ROWS.map(row => {
                  const formula = standardHeightFormula(row.plane)
                  const resolvedWcs = standardResolvedWcs(row.plane)
                  const authority = standardHeightAuthority(row.plane)
                  const operationRow = isOperationPlane(row.plane)
                  const offset = formula.offset ?? (operationRow ? resolvedWcs ?? 0 : 0)
                  const isExpanded = expandedHeightPlane === row.plane
                  const formulaMath = formula.offset === undefined
                    ? formula.sourceLabel
                    : `${formula.sourceLabel} ${offset >= 0 ? '+' : '-'} ${fmtDim(Math.abs(offset), displayUnits)} ${unitLabel(displayUnits)}`
                  return (
                    <div
                      key={row.plane}
                      data-testid={`standard-height-${row.plane}`}
                      data-expanded={isExpanded ? 'true' : 'false'}
                      style={{
                        borderBottom: '1px solid var(--border-subtle)', padding: '2px 0',
                        gridRow: row.plane === 'bottom' && expandedHeightPlane === 'top'
                          ? 6
                          : STANDARD_HEIGHT_ROWS.findIndex(candidate => candidate.plane === row.plane) + 1,
                      }}
                    >
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '18px 128px minmax(140px, 1fr) minmax(105px, auto) 86px',
                          gap: 8,
                          alignItems: 'center',
                          minHeight: 34,
                        }}
                      >
                        <button
                          type="button"
                          aria-label={tx('NewOperationModalBody.height', { p1: isExpanded ? tx('NewOperationModalBody.Collapse') : tx('NewOperationModalBody.Expand'), p2: row.label })}
                          onClick={() => setExpandedHeightPlane(current =>
                            current === row.plane ? null : row.plane)}
                          style={{
                            border: 0, background: 'transparent', color: 'inherit', padding: 0,
                            display: 'grid', placeItems: 'center', cursor: 'pointer',
                          }}
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <strong style={{ whiteSpace: 'nowrap' }}>{row.label}</strong>
                        <span data-testid={`standard-height-${row.plane}-formula`}>
                          <span data-testid={`standard-height-${row.plane}-source`}>{formulaMath}</span>
                        </span>
                        <strong data-testid={`standard-height-${row.plane}-resolved`}>{tx('NewOperationModalBody.WCS', { p1: resolvedWcs === undefined
                            ? '--'
                            : `${fmtDim(resolvedWcs, displayUnits)} ${unitLabel(displayUnits)}` })}</strong>
                        <span
                          className="op-hint"
                          data-testid={`standard-height-${row.plane}-authority`}
                          style={{ color: authority === 'User Override' ? 'var(--accent)' : undefined }}
                        >
                          {authority}
                        </span>
                      </div>
                      {isExpanded && <div
                        data-testid={`standard-height-${row.plane}-expanded`}
                        style={{ display: 'grid', gap: 8, padding: '8px 8px 10px 26px' }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) 56px minmax(110px, 0.7fr)', gap: 8 }}>
                          <select
                            className="op-select"
                            data-testid={`standard-height-${row.plane}-source-control`}
                            aria-label={tx('NewOperationModalBody.source', { p1: row.label })}
                            value={formula.reference ?? SMART_ROW_OPTION}
                            disabled={!formula.editable || (!operationRow && !formula.reference)}
                            onChange={event => operationRow
                              ? editOperationHeightReference(row.plane as 'top' | 'bottom', event.target.value)
                              : editStandardHeightReference(row.plane, event.target.value as HeightReference)}
                          >
                            {formula.smartLabel !== undefined
                              ? <option value={SMART_ROW_OPTION}>{formula.smartLabel}</option>
                              : !formula.reference && <option value={SMART_ROW_OPTION}>{formula.sourceLabel}</option>}
                            {(row.plane === 'bottom' && planarRowOwnsBottom
                              ? [
                                  ...PLANAR_BOTTOM_ROW_OPTIONS,
                                  ...(formula.reference && !PLANAR_BOTTOM_ROW_OPTIONS.some(option =>
                                    option.value === formula.reference)
                                    ? [{ value: formula.reference, label: formula.sourceLabel }]
                                    : []),
                                ]
                              : row.references).map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <select
                            className="op-select"
                            data-testid={`standard-height-${row.plane}-operator-control`}
                            aria-label={tx('NewOperationModalBody.offset_operator', { p1: row.label })}
                            value={offset >= 0 ? '+' : '-'}
                            disabled={!formula.editable ||
                              (!operationRow && (!formula.reference || formula.offset === undefined))}
                            onChange={event => {
                              const signed = Math.abs(offset) * (event.target.value === '-' ? -1 : 1)
                              if (operationRow) {
                                editOperationHeightOffset(row.plane as 'top' | 'bottom', formula.reference, signed)
                                return
                              }
                              if (!formula.reference) return
                              editStandardHeightOffset(row.plane, formula.reference, signed)
                            }}
                          >
                            <option value="+">{tx('NewOperationModalBody.symbol_8')}</option>
                            <option value="-">{tx('NewOperationModalBody.symbol_9')}</option>
                          </select>
                          <div className="op-field-input-row" data-testid={`standard-height-${row.plane}-offset-control`}>
                            <NumericInput
                              className="op-field-input"
                              ariaLabel={tx('NewOperationModalBody.Height_offset', { p1: row.label })}
                              value={authority === 'User Override' ? Math.abs(offset) : heightOffsetBoxValue(Math.abs(offset), displayUnits)}
                              step={0.5}
                              units={displayUnits}
                              disabled={!formula.editable ||
                                (!operationRow && (!formula.reference || formula.offset === undefined))}
                              onChange={magnitude => {
                                const signed = Math.abs(magnitude) * (offset < 0 ? -1 : 1)
                                if (operationRow) {
                                  editOperationHeightOffset(row.plane as 'top' | 'bottom', formula.reference, signed)
                                  return
                                }
                                if (!formula.reference) return
                                editStandardHeightOffset(row.plane, formula.reference, signed)
                              }}
                            />
                            <span className="op-field-unit">{unitLabel(displayUnits)}</span>
                          </div>
                        </div>
                      </div>}
                    </div>
                  )
                })}
              </div>
              <div
                data-testid="operation-height-policy-controls"
                hidden={expandedHeightPlane !== 'top' && expandedHeightPlane !== 'bottom'}
                style={{
                  marginTop: 4,
                  gridRow: expandedHeightPlane === 'top' ? 5 : 6,
                }}
              >
              {(isParallel3d || isSteepShallow3d || isScallop3d || isPencil3d) && (
                <div className="op-pass-summary" data-testid="parallel3d-height-policy" style={{ marginBottom: 12 }}>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <span className="op-field-label">{tx('NewOperationModalBody.Target_field')}</span>
                    </div>
                    <div className="op-field-control">
                      <strong data-testid="parallel3d-height-mode">
                        {heightRepairRequired
                          ? tx('NewOperationModalBody.Repair_required')
                          : parallelHeightFinishDepth === undefined
                            ? tx('NewOperationModalBody.Full_target_surface')
                            : tx('NewOperationModalBody.Target_surface_limited_below_model_Top', { p1: fmtDim(parallelHeightFinishDepth, displayUnits), p2: unitLabel(displayUnits) })}
                      </strong>
                    </div>
                  </div>
                  {heightRepairRequired ? (
                    <div style={{ marginTop: 10 }}>
                      <div className="op-hint op-hint-warn" data-testid="parallel3d-repair-height-note">
                        {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                      </div>
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="parallel3d-repair-height"
                        style={{ marginTop: 8 }}
                        onClick={() => {
                          setParallel3dHeightAuthority('smart_v2')
                          setHeightRepairMessage(null)
                        }}
                      >{tx('NewOperationModalBody.Reselect_height_policy')}</button>
                    </div>
                  ) : (
                    <div data-testid="parallel3d-height-preflight" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Resolved_preflight')}</strong>
                      <LiveSmartHeightPlan
                        preview={parallel3dHeightPreview}
                        idleMessage={tx('NewOperationModalBody.Select_an_imported_STL_or_STEP_solid_to_resolve')}
                        repairMessage={heightRepairMessage}
                      />
                    </div>
                  )}
                </div>
              )}
              {isWaterline3d && (
                <div className="op-pass-summary" data-testid="waterline3d-height-policy" style={{ marginBottom: 12 }}>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <span className="op-field-label">{tx('NewOperationModalBody.Target_field')}</span>
                    </div>
                    <div className="op-field-control">
                      <strong data-testid="waterline3d-height-mode">
                        {heightRepairRequired
                          ? tx('NewOperationModalBody.Repair_required')
                          : waterline3d.finishDepth === undefined
                            ? tx('NewOperationModalBody.Full_target_surface')
                            : tx('NewOperationModalBody.Target_surface_limited_below_model_Top', { p1: fmtDim(waterline3d.finishDepth, displayUnits), p2: unitLabel(displayUnits) })}
                      </strong>
                    </div>
                  </div>
                  {heightRepairRequired ? (
                    <div style={{ marginTop: 10 }}>
                      <div className="op-hint op-hint-warn" data-testid="waterline3d-repair-height-note">
                        {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                      </div>
                      <button
                        type="button"
                        className="op-toggle-btn"
                        data-testid="waterline3d-repair-height"
                        style={{ marginTop: 8 }}
                        onClick={() => {
                          setWaterline3dHeightAuthority('smart_v2')
                          setHeightRepairMessage(null)
                        }}
                      >{tx('NewOperationModalBody.Reselect_height_policy')}</button>
                    </div>
                  ) : (
                    <div data-testid="waterline3d-height-preflight" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Resolved_preflight')}</strong>
                      <LiveSmartHeightPlan
                        preview={waterline3dHeightPreview}
                        idleMessage={tx('NewOperationModalBody.Select_an_imported_STL_or_STEP_solid_to_resolve')}
                        repairMessage={heightRepairMessage}
                      />
                    </div>
                  )}
                </div>
              )}
              {isAdaptive3d && (
                <div className="op-pass-summary" data-testid="adaptive3d-height-policy" style={{ marginBottom: 12 }}>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <label className="op-field-label" htmlFor="adaptive3d-material-source">{tx('NewOperationModalBody.Material_source')}</label>
                    </div>
                    <div className="op-field-control">
                      <select
                        id="adaptive3d-material-source"
                        className="op-select"
                        data-testid="adaptive3d-material-source"
                        style={{ paddingRight: 28 }}
                        value={heightRepairRequired
                          ? 'repair_required'
                          : adaptive3dSourceHeldByRow ? HEIGHT_ROW_HELD_OPTION : adaptive3dHeightDraft.mode}
                        onChange={event => {
                          const mode = event.target.value as typeof adaptive3dHeightDraft.mode
                          if (!adaptive3dSourceHeldByRow && mode !== 'bounded_band') {
                            // Only where cutting starts changes; a Bottom row stays in effect.
                            setAdaptive3dHeightAuthority('smart_v2')
                            setHeightRepairMessage(null)
                            setAdaptive3dHeightDraft(current => ({ ...current, mode }))
                            return
                          }
                          const inEffect = replaceRowHeldPlanes(
                            tx('NewOperationModalBody.Material_source_choice', { p1: event.target.options[event.target.selectedIndex]?.text ?? mode }))
                          setAdaptive3dHeightAuthority('smart_v2')
                          setHeightRepairMessage(null)
                          setAdaptive3dHeightDraft(current => ({
                            ...current, mode,
                            ...(mode === 'bounded_band' ? {
                              topWcsMm: inEffect.top ?? current.topWcsMm,
                              bottomWcsMm: inEffect.bottom ?? current.bottomWcsMm,
                            } : {}),
                          }))
                          setRowPlaneOverrides({})
                        }}
                      >
                        {heightRepairRequired && (
                          <option value="repair_required" disabled>{tx('NewOperationModalBody.Repair_required')}</option>
                        )}
                        {!heightRepairRequired && adaptive3dSourceHeldByRow && (
                          <option value={HEIGHT_ROW_HELD_OPTION} disabled>
                            {policyHeldLabel()}
                          </option>
                        )}
                        <option value="current_material">{tx('NewOperationModalBody.Current_material_recommended')}</option>
                        <option value="initial_stock">{tx('NewOperationModalBody.Initial_stock')}</option>
                        <option value="bounded_band">{tx('NewOperationModalBody.Explicit_WCS_band')}</option>
                      </select>
                    </div>
                  </div>

                  {heightRepairRequired ? (
                    <div className="op-hint op-hint-warn" data-testid="adaptive3d-repair-height-note">
                      {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                    </div>
                  ) : null}

                  {!heightRepairRequired && adaptive3dHeightDraft.mode === 'bounded_band' && (
                    <div data-testid="adaptive3d-bounded-band" style={{ marginTop: 10 }}>
                      {!heldByRow('top') && <NumberField
                        label={tx('NewOperationModalBody.Band_top_WCS')} unit="mm" units={displayUnits}
                        value={adaptive3dHeightDraft.topWcsMm} step={0.5}
                        onChange={topWcsMm => {
                          setAdaptive3dHeightDraft(current => ({ ...current, topWcsMm }))
                          setRowPlaneOverride('top', undefined)
                        }}
                      />}
                      {!heldByRow('bottom') && <NumberField
                        label={tx('NewOperationModalBody.Band_bottom_WCS')} unit="mm" units={displayUnits}
                        value={adaptive3dHeightDraft.bottomWcsMm} step={0.5}
                        onChange={bottomWcsMm => {
                          setAdaptive3dHeightDraft(current => ({ ...current, bottomWcsMm }))
                          setRowPlaneOverride('bottom', undefined)
                        }}
                      />}
                      {!adaptive3dBandValid && (
                        <div className="op-hint op-hint-warn" data-testid="adaptive3d-bounded-band-error">{tx('NewOperationModalBody.Band_top_must_be_greater_than_or_equal_to')}</div>
                      )}
                    </div>
                  )}

                  {!heightRepairRequired && (
                    <div data-testid="adaptive3d-height-preflight" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Resolved_preflight')}</strong>
                      <LiveSmartHeightPlan
                        preview={adaptive3dHeightPreview}
                        idleMessage={tx('NewOperationModalBody.Select_a_supported_tool_and_3D_solid_to_resolve')}
                        repairMessage={heightRepairMessage}
                      />
                    </div>
                  )}
                </div>
              )}
              {isFace && (
                <div className="op-pass-summary" data-testid="face-height-policy" style={{ marginBottom: 12 }}>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <label className="op-field-label" htmlFor="face-height-mode">{tx('NewOperationModalBody.Finished_face')}</label>
                    </div>
                    <div className="op-field-control">
                      <select
                        id="face-height-mode"
                        className="op-select"
                        data-testid="face-height-mode"
                        style={{ paddingRight: 28 }}
                        value={heightRepairRequired
                          ? 'repair_required'
                          : policyHeldByRow ? HEIGHT_ROW_HELD_OPTION
                          : faceHeightChosen ? faceHeightDraft.mode : ''}
                        onChange={event => {
                          const mode = event.target.value as typeof faceHeightDraft.mode
                          const inEffect = replaceRowHeldPlanes(
                            tx('NewOperationModalBody.Finished_face_choice', { p1: event.target.options[event.target.selectedIndex]?.text ?? mode }))
                          // WO-2694: leaving the smart Model top for an explicit
                          // plane starts from the plane it resolved to.
                          const smartBottom = faceHeightDraft.mode === 'model_top' &&
                            faceHeightPreview.state === 'resolved'
                            ? faceHeightPreview.plan.machining.physicalTarget?.wcsMm
                            : undefined
                          setFaceHeightDraft(current => ({
                            ...current, mode,
                            ...(mode === 'explicit_depth' && smartBottom !== undefined
                              ? { explicitTargetWcsMm: smartBottom } : {}),
                            ...(mode === 'explicit_depth' && inEffect.bottom !== undefined
                              ? { explicitTargetWcsMm: inEffect.bottom } : {}),
                          }))
                          setRowPlaneOverride('bottom', undefined)
                          setFaceHeightAuthority('smart_v2')
                          setHeightRepairMessage(null)
                          setFaceHeightConfirmed(true)
                        }}
                      >
                        {heightRepairRequired && (
                          <option value="repair_required" disabled>{tx('NewOperationModalBody.Repair_required')}</option>
                        )}
                        {faceHeightAuthority === 'new' && !faceHeightChosen && (
                          <option value="" disabled>{tx('NewOperationModalBody.Choose_the_intended_end_condition')}</option>
                        )}
                        {!heightRepairRequired && policyHeldByRow && (
                          <option value={HEIGHT_ROW_HELD_OPTION} disabled>
                            {policyHeldLabel()}
                          </option>
                        )}
                        {(faceHasModelTop || faceHeightDraft.mode === 'model_top') && (
                          <option value="model_top">{tx('NewOperationModalBody.Model_top_recommended')}</option>
                        )}
                        <option value="target_face">{tx('NewOperationModalBody.Selected_model_face_recommended')}</option>
                        <option value="explicit_depth">{tx('NewOperationModalBody.Explicit_WCS_plane')}</option>
                      </select>
                    </div>
                  </div>

                  {heightRepairRequired ? (
                    <div className="op-hint op-hint-warn" data-testid="face-repair-height-note">
                      {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                    </div>
                  ) : policyHeldByRow ? null : !faceHeightChosen ? (
                    <div className="op-hint op-hint-warn" data-testid="face-height-unconfirmed">{tx('NewOperationModalBody.Face_will_not_be_created_until_you_confirm_what')}</div>
                  ) : faceHeightDraft.mode === 'model_top' ? null : faceHeightDraft.mode === 'target_face' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      <button className="op-toggle-btn" data-testid="pick-face-target" onClick={startFaceTargetPlanePick}>
                        {face.targetPlaneGeo ? tx('NewOperationModalBody.Re_pick_finished_face') : tx('NewOperationModalBody.Pick_finished_face_in_workspace')}
                      </button>
                      <div className="op-hint" data-testid="face-target-readout">
                        {face.targetPlaneGeo
                          ? tx('NewOperationModalBody.Census_Target_face', { p1: geometryNameForId(face.targetPlaneGeo.geoId), p2: face.targetPlaneGeo.faceIndex })
                          : tx('NewOperationModalBody.No_target_face_selected_yet')}
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 8 }} data-testid="face-explicit-target">
                      <NumberField
                        label={tx('NewOperationModalBody.Target_End_WCS')} unit="mm" units={displayUnits}
                        value={faceHeightDraft.explicitTargetWcsMm} step={0.5}
                        onChange={explicitTargetWcsMm => {
                          setFaceHeightDraft(current => ({ ...current, explicitTargetWcsMm }))
                          setRowPlaneOverride('bottom', undefined)
                          setFaceHeightAuthority('smart_v2')
                          setFaceHeightConfirmed(true)
                        }}
                      />
                    </div>
                  )}

                  {!heightRepairRequired && faceHeightChosen && (
                    <div data-testid="face-height-preflight" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Resolved_preflight')}</strong>
                      <LiveSmartHeightPlan
                        preview={faceHeightPreview}
                        idleMessage={tx('NewOperationModalBody.Choose_the_finished_face_or_explicit_WCS_target_to')}
                        repairMessage={heightRepairMessage}
                      />
                    </div>
                  )}
                </div>
              )}
              {isContour && (
                <div className="op-pass-summary" data-testid="contour-height-policy" style={{ marginBottom: 12 }}>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <label className="op-field-label" htmlFor="contour-height-mode">{tx('NewOperationModalBody.Target_End')}</label>
                    </div>
                    <div className="op-field-control">
                      <select
                        id="contour-height-mode"
                        className="op-select"
                        data-testid="contour-height-mode"
                        style={{ paddingRight: 28 }}
                        value={heightRepairRequired
                          ? 'repair_required'
                          : policyHeldByRow ? HEIGHT_ROW_HELD_OPTION : contourHeightDraft.mode}
                        onChange={event => {
                          const mode = event.target.value as typeof contourHeightDraft.mode
                          const inEffect = replaceRowHeldPlanes(
                            tx('NewOperationModalBody.Target_End_choice', { p1: event.target.options[event.target.selectedIndex]?.text ?? mode }))
                          setContourHeightDraft(current => ({
                            ...current, mode,
                            ...(mode === 'explicit_depth' && inEffect.bottom !== undefined
                              ? { explicitTargetWcsMm: inEffect.bottom } : {}),
                          }))
                          setRowPlaneOverride('bottom', undefined)
                          setContourHeightAuthority('smart_v2')
                          setHeightRepairMessage(null)
                        }}
                      >
                        {heightRepairRequired && (
                          <option value="repair_required" disabled>{tx('NewOperationModalBody.Repair_required')}</option>
                        )}
                        {!heightRepairRequired && policyHeldByRow && (
                          <option value={HEIGHT_ROW_HELD_OPTION} disabled>
                            {policyHeldLabel()}
                          </option>
                        )}
                        <option value="selected_feature">{tx('NewOperationModalBody.Detected_feature_floor_recommended')}</option>
                        <option value="stock_bottom">{tx('NewOperationModalBody.Stock_bottom')}</option>
                        <option value="through_stock">{tx('NewOperationModalBody.Through_stock')}</option>
                        <option value="model_bottom">{tx('NewOperationModalBody.Target_model_bottom')}</option>
                        <option value="explicit_depth">{tx('NewOperationModalBody.Explicit_WCS_Z')}</option>
                      </select>
                    </div>
                  </div>

                  {heightRepairRequired ? (
                    <div className="op-hint op-hint-warn" data-testid="contour-repair-height-note">
                      {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                    </div>
                  ) : null}

                  {!heightRepairRequired && !policyHeldByRow && contourHeightDraft.mode === 'through_stock' && (
                    <div style={{ marginTop: 8 }}>
                      <NumberField
                        label={tx('NewOperationModalBody.Past_stock_bottom')} unit="mm" units={displayUnits}
                        value={contourHeightDraft.throughAllowanceMm} min={0} step={0.1}
                        onChange={throughAllowanceMm => {
                          setContourHeightDraft(current => ({ ...current, throughAllowanceMm }))
                          setRowPlaneOverride('bottom', undefined)
                          setContourHeightAuthority('smart_v2')
                        }}
                      />
                    </div>
                  )}
                  {!heightRepairRequired && !policyHeldByRow && contourHeightDraft.mode === 'explicit_depth' && (
                    <div style={{ marginTop: 8 }}>
                      <NumberField
                        label={tx('NewOperationModalBody.Target_End_WCS')} unit="mm" units={displayUnits}
                        value={contourHeightDraft.explicitTargetWcsMm} step={0.5}
                        onChange={explicitTargetWcsMm => {
                          setContourHeightDraft(current => ({ ...current, explicitTargetWcsMm }))
                          setRowPlaneOverride('bottom', undefined)
                          setContourHeightAuthority('smart_v2')
                        }}
                      />
                    </div>
                  )}

                  {!heightRepairRequired && (
                    <div data-testid="contour-height-preflight" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Resolved_preflight')}</strong>
                      <LiveSmartHeightPlan
                        preview={contourHeightPreview}
                        idleMessage={tx('NewOperationModalBody.Select_at_least_one_machining_loop_to_resolve_the')}
                        // A new Contour's refusal already names what it needs;
                        // the saved-authority repair line would only confuse it.
                        repairMessage={heightRepairMessage ?? ''}
                      />
                    </div>
                  )}
                </div>
              )}
              {(isDrill || isBore) && (
                <div className="op-pass-summary" data-testid="drill-bore-height-policy" style={{ marginBottom: 12 }}>
                  <div className="op-field-row">
                    <div className="op-field-label-wrap">
                      <label className="op-field-label" htmlFor="drill-bore-height-mode">{tx('NewOperationModalBody.Depth_policy')}</label>
                    </div>
                    <div className="op-field-control">
                      <select
                        id="drill-bore-height-mode"
                        className="op-select"
                        data-testid="drill-bore-height-mode"
                        style={{ paddingRight: 28 }}
                        value={heightRepairRequired
                          ? 'repair_required'
                          : policyHeldByRow ? HEIGHT_ROW_HELD_OPTION : drillBoreHeightDraft.mode}
                        onChange={event => {
                          const mode = event.target.value as typeof drillBoreHeightDraft.mode
                          const inEffect = replaceRowHeldPlanes(
                            tx('NewOperationModalBody.Depth_policy_choice', { p1: event.target.options[event.target.selectedIndex]?.text ?? mode }))
                          setDrillBoreHeightDraft(current => ({
                            ...current, mode,
                            ...(mode === 'explicit_depth' ? {
                              explicitStartWcsMm: inEffect.top ?? current.explicitStartWcsMm,
                              explicitEndWcsMm: inEffect.bottom ?? current.explicitEndWcsMm,
                            } : {}),
                          }))
                          setRowPlaneOverrides({})
                          setDrillBoreHeightAuthority('smart_v2')
                          setHeightRepairMessage(null)
                          if (isDrill) setDrill(current => ({ ...current, perHoleDepth: mode === 'detected_features' }))
                          else setBore(current => ({ ...current, perBoreDepth: mode === 'detected_features' }))
                        }}
                      >
                        {heightRepairRequired && (
                          <option value="repair_required" disabled>{tx('NewOperationModalBody.Repair_required')}</option>
                        )}
                        {!heightRepairRequired && policyHeldByRow && (
                          <option value={HEIGHT_ROW_HELD_OPTION} disabled>
                            {policyHeldLabel()}
                          </option>
                        )}
                        <option value="detected_features">{tx('NewOperationModalBody.Detected_physical_floors_recommended')}</option>
                        <option value="explicit_depth">{tx('NewOperationModalBody.Explicit_Material_Start_and_Target_End')}</option>
                      </select>
                    </div>
                  </div>

                  {heightRepairRequired ? (
                    <div className="op-hint op-hint-warn" data-testid="drill-bore-repair-height-note">
                      {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                    </div>
                  ) : drillBoreHeightDraft.mode === 'detected_features' ? (
                    !heldByRow('bottom') && <>
                      <div style={{ marginTop: 8 }} ref={drillBreakThroughFieldRef}>
                        <NumberField key={drillBreakThroughFieldKey}
                          label={tx('NewOperationModalBody.Breakthrough_past_floor')} unit="mm" units={displayUnits}
                          value={isDrill ? (drill.breakthroughMm ?? 0) : (bore.breakthroughMm ?? 0)}
                          min={0} step={0.1}
                          onChange={breakthroughMm => {
                            if (isDrill) setDrillBreakThroughByUser(breakthroughMm)
                            else setBore(current => ({ ...current, breakthroughMm }))
                            setDrillBoreHeightAuthority('smart_v2')
                          }}
                        />
                        {drillBreakThroughNote && <div className="op-hint" data-testid="drill-break-through-default-note">{drillBreakThroughNote}</div>}
                      </div>
                    </>
                  ) : (
                    <div data-testid="drill-bore-explicit-depth" style={{ marginTop: 8 }}>
                      {!heldByRow('top') && <NumberField
                        label={tx('NewOperationModalBody.Material_Start_WCS')} unit="mm" units={displayUnits}
                        value={drillBoreHeightDraft.explicitStartWcsMm} step={0.5}
                        onChange={explicitStartWcsMm => {
                          setDrillBoreHeightDraft(current => ({ ...current, explicitStartWcsMm }))
                          setRowPlaneOverride('top', undefined)
                          setDrillBoreHeightAuthority('smart_v2')
                        }}
                      />}
                      {!heldByRow('bottom') && <NumberField
                        label={tx('NewOperationModalBody.Target_End_WCS')} unit="mm" units={displayUnits}
                        value={drillBoreHeightDraft.explicitEndWcsMm} step={0.5}
                        onChange={explicitEndWcsMm => {
                          setDrillBoreHeightDraft(current => ({ ...current, explicitEndWcsMm }))
                          setRowPlaneOverride('bottom', undefined)
                          setDrillBoreHeightAuthority('smart_v2')
                        }}
                      />}
                      {/* WO-2514: a Drill set by explicit depth breaks through on purpose -
                          the full diameter passes the bottom by this much, point length added. */}
                      {isDrill && <>
                        <div ref={drillBreakThroughFieldRef}>
                          <NumberField key={drillBreakThroughFieldKey}
                            label={tx('NewOperationModalBody.Breakthrough_past_floor')} unit="mm" units={displayUnits}
                            value={drill.breakthroughMm ?? 0}
                            min={0} step={0.1}
                            onChange={breakthroughMm => {
                              setDrillBreakThroughByUser(breakthroughMm)
                              setDrillBoreHeightAuthority('smart_v2')
                            }}
                          />
                        </div>
                        {drillBreakThroughNote && <div className="op-hint" data-testid="drill-break-through-default-note">{drillBreakThroughNote}</div>}
                        {(drill.breakthroughMm ?? 0) > 0 &&
                          activeResolvedHeightPlan?.machining.cutterCenterEnd !== undefined && (
                          <div className="op-hint" data-testid="drill-explicit-breakthrough-note">
                            {tx('NewOperationModalBody.Break_through_tip', {
                              p1: fmtMachineLength(activeResolvedHeightPlan.machining.cutterCenterEnd.wcsMm, displayUnits),
                              p2: unitLabel(displayUnits),
                              p3: fmtMachineLength(drill.breakthroughMm ?? 0, displayUnits),
                            })}
                          </div>
                        )}
                      </>}
                    </div>
                  )}

                  {!heightRepairRequired && (
                    <div data-testid="drill-bore-height-preflight" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Resolved_preflight')}</strong>
                      <LiveSmartHeightPlan
                        preview={drillBoreHeightPreview}
                        idleMessage={tx('NewOperationModalBody.Select_at_least_one_machining_circle_to_resolve_the')}
                        repairMessage={heightRepairMessage}
                      />
                    </div>
                  )}
                </div>
              )}
              {endConditionSupported && !planarRoughUsesStockBoundary && (
                <div className="op-field-row" data-testid="end-condition-control" style={{ marginBottom: 10 }}>
                  <div className="op-field-label-wrap">
                    <label className="op-field-label">{tx('NewOperationModalBody.End_condition')}</label>
                  </div>
                  <div className="op-field-control" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <select
                      className="op-select"
                      value={endCondition}
                      onChange={event => setEndCondition(event.target.value as EndCondition)}
                    >
                      <option value="depth_from_top">{tx('NewOperationModalBody.Depth_from_stock_top')}</option>
                      <option value="to_geometry">{tx('NewOperationModalBody.To_geometry_datum')}</option>
                      <option value="to_stock_bottom">{tx('NewOperationModalBody.To_stock_bottom')}</option>
                      <option value="through_stock">{tx('NewOperationModalBody.Through_stock')}</option>
                      <option value="stop_above_bottom">{tx('NewOperationModalBody.Stop_above_stock_bottom')}</option>
                      <option value="selected_surface">{tx('NewOperationModalBody.To_selected_surface')}</option>
                      <option value="custom">{tx('NewOperationModalBody.Custom_reference_offset')}</option>
                    </select>
                    {endCondition === 'depth_from_top' && (
                      <NumberField
                        label={tx('NewOperationModalBody.Depth_from_top')} unit="mm" units={displayUnits}
                        value={Math.abs(endOffset)} min={0.001} step={0.5}
                        onChange={value => setEndReference('stock_top', -Math.abs(value))}
                      />
                    )}
                    {endCondition === 'through_stock' && (
                      <NumberField
                        label={tx('NewOperationModalBody.Past_stock_bottom')} unit="mm" units={displayUnits}
                        value={Math.abs(endOffset)} min={0} step={0.1}
                        onChange={value => setEndReference('stock_bottom', -Math.abs(value))}
                      />
                    )}
                    {endCondition === 'stop_above_bottom' && (
                      <NumberField
                        label={tx('NewOperationModalBody.Material_left_above_bottom')} unit="mm" units={displayUnits}
                        value={Math.abs(endOffset)} min={0} step={0.1}
                        onChange={value => setEndReference('stock_bottom', Math.abs(value))}
                      />
                    )}
                    <span className="op-hint">
                      {endCondition === 'depth_from_top'
                        ? tx('NewOperationModalBody.down_from_stock_top', { p1: fmtDim(Math.abs(endOffset), displayUnits), p2: unitLabel(displayUnits) })
                        : endCondition === 'through_stock'
                          ? tx('NewOperationModalBody.Cuts_through_stock_and_travels_past_its_bottom', { p1: fmtDim(Math.abs(endOffset), displayUnits), p2: unitLabel(displayUnits) })
                          : endCondition === 'stop_above_bottom'
                            ? tx('NewOperationModalBody.Leaves_of_material_above_stock_bottom', { p1: fmtDim(Math.abs(endOffset), displayUnits), p2: unitLabel(displayUnits) })
                            : endCondition === 'selected_surface'
                              ? tx('NewOperationModalBody.The_picked_model_surface_is_the_nominal_termination_plane')
                              : endCondition === 'to_geometry'
                                ? tx('NewOperationModalBody.The_selected_2D_model_geometry_plane_is_the_nominal')
                                : endCondition === 'to_stock_bottom'
                                  ? tx('NewOperationModalBody.The_nominal_termination_plane_is_stock_bottom')
                                  : tx('NewOperationModalBody.Advanced_Reference_plane_and_Offset_controls_below_define_the')}
                    </span>
                  </div>
                </div>
              )}

              {/* Top/Bottom-of-cut reference block. parallel_3d takes top+bottom
                  from the SOLID's own bounds (resolveParallel3dHeights uses
                  mesh.bounds), so none of these fields apply to it — only the
                  Clearance/Retract/Feed planes above do. Hide the whole block for
                  the 3D finish. (A real "limit finish depth" bottom is hitlisted.) */}
              {!isParallel3d && !isWaterline3d && !isSteepShallow3d && !isScallop3d && !isPencil3d && !isAdaptive3d &&
               !isFace && !isContour && !(isDrill || isBore) && (isChamfer ? (
                <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Chamfer_reference_plane')}</p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                    <label className="op-field-label">{tx('NewOperationModalBody.Reference_plane')}</label>
                    <RefPlaneSelect
                      value={chamfer.heightReference ?? 'absolute'}
                      onChange={setOpHeightReferenceAny}
                    />
                  </div>

                  {(chamfer.heightReference ?? 'absolute') === 'picked_plane' && renderPickedDatumBlock()}

                  <NumberField
                    label={(chamfer.heightReference ?? 'absolute') === 'absolute' ? 'Z (WCS)' : tx('NewOperationModalBody.Z_offset_from_plane')}
                    unit="mm" units={displayUnits}
                    value={chamfer.planeOffset ?? 0}
                    min={(chamfer.heightReference ?? 'absolute') === 'absolute' ? -9999 : -50}
                    max={(chamfer.heightReference ?? 'absolute') === 'absolute' ?  9999 :  50}
                    step={0.1}
                    onChange={v => {
                      const hUpd = deriveHeightPlaneOffsetUpdate(
                        'chamfer', heights, chamfer, chamfer.heightReference ?? 'absolute', v,
                      )
                      setChamfer(c => ({ ...c, planeOffset: v }))
                      setHeights(h => ({ ...h, ...hUpd }))
                    }}
                  />

                  {chamferHeightAuthority === 'repair_required' ? (
                    <div className="op-hint op-hint-warn" data-testid="chamfer-repair-height-note">
                      {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                      <button
                        type="button"
                        className="op-toggle-btn"
                        style={{ marginTop: 8 }}
                        onClick={() => {
                          setChamferRepairConfirmed(true)
                          setHeightRepairMessage(null)
                        }}
                      >{tx('NewOperationModalBody.Use_the_current_edge_selections_and_height_policy')}</button>
                    </div>
                  ) : (
                    <div data-testid="chamfer-height-policy">
                      <LiveSmartHeightPlan
                        preview={chamferHeightPreview}
                        idleMessage={tx('NewOperationModalBody.Select_a_chamfer_edge_and_tool_to_resolve_the')}
                        repairMessage={heightRepairMessage}
                      />
                    </div>
                  )}

                  {chamferHeightAuthority === 'repair_required' && chamferResolvedTopZ !== null && (
                    <div className="op-pass-summary">
                      <span>
                        {tx('NewOperationModalBody.Reference_plane_WCS_Z', { p1: fmtDim(chamferResolvedTopZ, displayUnits), p2: unitLabel(displayUnits) })}
                        {chamferDepthMm != null ? (() => {
                          const tipWcsZ = chamferResolvedTopZ - chamferDepthMm
                          return tx('NewOperationModalBody.tip_at_WCS_Z_depth', { p1: fmtDim(tipWcsZ, displayUnits), p2: unitLabel(displayUnits), p3: fmtDim(chamfer.chamferWidth, displayUnits), p4: unitLabel(displayUnits), p5: chamfer.tipOffset > 0 ? tx('NewOperationModalBody.Census_extra', { p1: fmtDim(chamfer.tipOffset, displayUnits), p2: unitLabel(displayUnits) }) : '' })
                        })() : ''}
                        {chamfer.heightReference === 'geometry_face' && (() => {
                          if (!chamfer.geometryId) return tx('NewOperationModalBody.no_geometry_selected')
                          if (chamfer.geometryId === '__all__') return tx('NewOperationModalBody.all_parts_using_highest_face_Z')
                          const found = project.geometry.find(g => g.id === chamfer.geometryId)
                          if (!found) return tx('NewOperationModalBody.geometry_not_found_re_select_in_Geometry_tab')
                          const hasLayerPlane = (found.layers2d ?? []).some(l => l.projectionPlane != null)
                          if (!found.projectionPlane && !hasLayerPlane) return tx('NewOperationModalBody.no_projection_plane_using_bbox_top_Z')
                          return ''
                        })()}
                      </span>
                    </div>
                  )}
                </>
              ) : isPocket ? (
                <>
                  {/* WO-1601: no "Top of stock (Z)" for Pocket / Adaptive Clearing -
                      their Smart plan starts at current material and never read
                      it. The Top Height row is the control that moves the start. */}
                  {planarEndFieldsShown && <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Bottom_of_cut')}</p>
                  {heights.bottomHeightMode === 'selected_face' && heights.selectedFaceZ !== undefined && (() => {
                    const frames = resolveGeometryZToFrames(heights.selectedFaceZ, selectedGeo ?? undefined, setup)
                    return (
                      <div className="op-pass-summary" data-testid="heights-selected-face" style={{ marginBottom: 8 }}>
                        <span>{tx('NewOperationModalBody.Bottom_of_cut_picked_model_face_WCS_Z_from', { p1: fmtDim(frames.wcsZ, displayUnits), p2: unitLabel(displayUnits), p3: fmtDim(frames.worldZ, displayUnits), p4: unitLabel(displayUnits) })}</span>
                        <button className="op-toggle-btn" style={{ marginTop: 6 }}
                          onClick={clearSelectedBottom}>{tx('NewOperationModalBody.Clear_use_reference_plane')}</button>
                      </div>
                    )
                  })()}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                    <label className="op-field-label">{tx('NewOperationModalBody.Reference_plane')}</label>
                    <RefPlaneSelect
                      value={pocket.heightReference ?? 'geometry_face'}
                      onChange={setOpHeightReferenceAny}
                    />
                  </div>
                  {(pocket.heightReference ?? 'geometry_face') === 'picked_plane' && renderPickedDatumBlock()}
                  <NumberField
                    label={(pocket.heightReference ?? 'geometry_face') === 'absolute' ? 'Z (WCS)' : tx('NewOperationModalBody.Z_offset_from_plane')}
                    unit="mm" units={displayUnits}
                    value={pocket.planeOffset ?? 0}
                    min={(pocket.heightReference ?? 'geometry_face') === 'absolute' ? -9999 : -50}
                    max={(pocket.heightReference ?? 'geometry_face') === 'absolute' ?  9999 :  50}
                    step={0.1}
                    onChange={v => {
                      setRowPlaneOverride('bottom', undefined)
                      setPocket(p => ({ ...p, planeOffset: v }))
                      // Editing the BOTTOM-of-cut offset is an explicit manual
                      // override -> suppress recompute-time cylinder-floor heal.
                      setHeights(h => ({
                        ...h,
                        ...deriveHeightPlaneOffsetUpdate(
                          'pocket_2d', h, pocket, pocket.heightReference ?? 'geometry_face', v,
                        ),
                        // An absolute Z is the explicit Target End itself.
                        ...((pocket.heightReference ?? 'geometry_face') === 'absolute' ? { bottomHeight: v } : {}),
                      }))
                    }}
                  />
                  </>}
                </>
              ) : (
                <>
                  {/* Top of cut: face/engrave derive it from the reference plane
                      (selector below). Adaptive Clearing's Smart plan never read
                      the explicit field (WO-1601), so it is not shown there.
                      External thread mills are bottom-governed but derive the top
                      as base + threadDepth, so they skip the explicit top field. */}
                  {!refGovernsTop && !isThreadMill && !isAdaptive && (
                    <NumberField label={tx('NewOperationModalBody.Top_of_stock_Z')} unit="mm" units={displayUnits}
                      value={heights.topHeight} step={1}
                      onChange={v => editNumericHeight('top', v, { topHeight: v })}
                    />
                  )}

                  {/* Bottom-of-cut reference plane selector (generalized from
                      pocket; same enum). Face/Engrave: the reference is the TOP
                      of cut. Everything else: the BOTTOM of cut. */}
                  {refSupported && (!isAdaptive || planarEndFieldsShown) && (
                    <>
                      {isThreadMill ? (
                        <p className="op-section-label" data-testid="thread-datum-label">{tx('NewOperationModalBody.Thread_datum')}</p>
                      ) : (
                        <p className="op-section-label" data-testid="ref-section-label">
                          {refGovernsTop ? tx('NewOperationModalBody.Top_of_cut') : tx('NewOperationModalBody.Bottom_of_cut')}
                        </p>
                      )}
                      {!isThreadMill && !refGovernsTop && heights.bottomHeightMode === 'selected_face' && heights.selectedFaceZ !== undefined && (() => {
                        const frames = resolveGeometryZToFrames(heights.selectedFaceZ, selectedGeo ?? undefined, setup)
                        return (
                          <div className="op-pass-summary" data-testid="heights-selected-face" style={{ marginBottom: 8 }}>
                            <span>{tx('NewOperationModalBody.Bottom_of_cut_picked_model_face_hole_WCS_Z', { p1: fmtDim(frames.wcsZ, displayUnits), p2: unitLabel(displayUnits), p3: fmtDim(frames.worldZ, displayUnits), p4: unitLabel(displayUnits) })}</span>
                            <button className="op-toggle-btn" style={{ marginTop: 6 }}
                              onClick={clearSelectedBottom}>{tx('NewOperationModalBody.Clear_use_reference_plane')}</button>
                          </div>
                        )
                      })()}
                      {!isThreadMill && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                          <label className="op-field-label">{tx('NewOperationModalBody.Reference_plane')}</label>
                          <RefPlaneSelect
                            testId="ref-plane-select"
                            value={opHeightReference}
                            onChange={setOpHeightReference}
                          />
                        </div>
                      )}
                      {!isThreadMill && opHeightReference === 'picked_plane' && renderPickedDatumBlock()}
                      {isThreadMill && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                          <span className="op-hint" data-testid="thread-datum-line">
                            {threadMillHeightAuthority === 'repair_required'
                              ? tx('NewOperationModalBody.Census_Datum_repair_required')
                              : threadMill.geometrySource === 'cylinder'
                                ? tx('NewOperationModalBody.Census_Datum_detected_cylinder', { p1: (threadMill.externalReference ?? 'top') === 'base' ? tx('NewOperationModalBody.Census_base') : tx('NewOperationModalBody.Census_top') })
                                : tx('NewOperationModalBody.Census_Datum_selected_circle_plane')}
                          </span>
                        </div>
                      )}
                      {/* For a bottom-governed op with 'absolute', the depth IS
                          the verbatim heights.bottomHeight (legacy field) - this
                          keeps old projects byte-identical. Any real reference
                          plane uses the (reference + planeOffset) model. */}
                      {!refGovernsTop && opHeightReference === 'absolute' ? (
                        <NumberField label={tx('NewOperationModalBody.Bottom_of_cut_Z')} unit="mm" units={displayUnits}
                          value={heights.bottomHeight} step={0.5}
                          onChange={v => editNumericHeight('bottom', v, {
                            bottomHeight: v, bottomHeightMode: 'absolute', selectedFaceZ: undefined, bottomManual: true,
                          })}
                        />
                      ) : (
                        <NumberField
                          label={opHeightReference === 'absolute' ? 'Z (WCS)' : tx('NewOperationModalBody.Z_offset_from_plane')}
                          unit="mm" units={displayUnits}
                          value={opPlaneOffset}
                          min={opHeightReference === 'absolute' ? -9999 : -50}
                          max={opHeightReference === 'absolute' ?  9999 :  50}
                          step={opHeightReference === 'absolute' ? 0.5 : 0.1}
                          onChange={setOpPlaneOffset}
                        />
                      )}
                    </>
                  )}

                  {/* Thread milling: an optional reference-DIRECTION toggle (external
                      only) plus a single thread-depth field for both kinds, rendered
                      independently of refGovernsTop so they always show.
                      INTERNAL = always top-referenced (reference plane = thread top);
                      the thread runs DOWN a pre-drilled hole (bottom = top - depth).
                      EXTERNAL = a reference-direction toggle:
                        'top'  (default): reference plane = boss TOP, thread runs DOWN
                          from it (bottom = top - depth).
                        'base': reference plane = boss BASE, thread climbs UP the boss
                          (top = base + depth).
                      The builder always climbs bottom-to-top regardless. */}
                  {isThreadMill && threadMill.threadKind === 'external' && (() => {
                    // Band-language labels: 'top' = top of cylinder (thread runs
                    // down); 'base' = base (thread climbs up). The <select> keeps
                    // its data-testid in BOTH presentation branches.
                    const sel = (
                      <select
                        className="mform-select"
                        data-testid="thread-external-reference"
                        value={threadMill.externalReference ?? 'top'}
                        onChange={e => {
                          const v = e.target.value as 'top' | 'base'
                          setThreadMill(t => ({ ...t, externalReference: v }))
                        }}
                      >
                        <option value="top">{tx('NewOperationModalBody.Top_of_cylinder_down')}</option>
                        <option value="base">{tx('NewOperationModalBody.Base_up')}</option>
                      </select>
                    )
                    // Cylinder pick already INFERRED 'top' from the face normal;
                    // demote the override behind an Advanced disclosure. A 2D loop /
                    // manual circle cannot infer direction -> show it prominently.
                    return threadMill.geometrySource === 'cylinder' ? (
                      <details data-testid="thread-direction-advanced" style={{ marginBottom: 8 }}>
                        <summary className="op-hint" style={{ cursor: 'pointer' }}>{tx('NewOperationModalBody.Advanced_thread_direction')}</summary>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                          <label className="op-field-label">{tx('NewOperationModalBody.Thread_reference')}</label>
                          {sel}
                        </div>
                      </details>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                        <label className="op-field-label">{tx('NewOperationModalBody.Thread_reference')}</label>
                        {sel}
                      </div>
                    )
                  })()}
                  {isThreadMill && (
                    threadMill.threadKind === 'external' && (threadMill.externalReference ?? 'top') === 'base' ? (
                      <NumberField label={tx('NewOperationModalBody.Thread_depth')} unit="mm" units={displayUnits}
                        value={threadMill.threadDepth ?? 0} min={0.01} step={0.5}
                        onChange={v => setThreadMill(t => ({ ...t, threadDepth: v }))}
                      />
                    ) : (
                      <NumberField label={tx('NewOperationModalBody.Thread_depth')} unit="mm" units={displayUnits}
                        value={threadMill.threadDepth ?? 0} min={0.01} step={0.5}
                        onChange={v => setThreadMill(t => ({ ...t, threadDepth: v }))}
                      />
                    )
                  )}
                  {isThreadMill && (
                    <div className="op-pass-summary" data-testid="thread-mill-height-policy" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Smart_thread_band')}</strong>
                      {threadMillHeightAuthority === 'repair_required' ? (
                        <div className="op-hint op-hint-warn" data-testid="thread-mill-repair-height-note">
                          {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                          <button
                            type="button"
                            className="op-toggle-btn"
                            style={{ marginTop: 8 }}
                            onClick={() => {
                              setThreadMillRepairConfirmed(true)
                              setHeightRepairMessage(null)
                            }}
                          >{tx('NewOperationModalBody.Use_the_current_geometry_and_thread_policy')}</button>
                        </div>
                      ) : (
                        <div data-testid="thread-mill-height-preflight" style={{ marginTop: 6 }}>
                          <div className="op-hint">
                            {threadMill.geometrySource === 'cylinder'
                              ? tx('NewOperationModalBody.The_selected_bore_or_boss_owns_the_physical_thread')
                              : tx('NewOperationModalBody.The_selected_circle_supplies_the_datum_plane_thread_direction')}
                          </div>
                          <LiveSmartHeightPlan
                            preview={threadMillHeightPreview}
                            idleMessage={tx('NewOperationModalBody.Select_at_least_one_machining_circle_and_a_tool')}
                            repairMessage={heightRepairMessage}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {isEngrave && (
                    <div className="op-pass-summary" data-testid="engrave-height-policy" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Smart_engraving_depth')}</strong>
                      {engraveHeightAuthority === 'repair_required' ? (
                        <div className="op-hint op-hint-warn" data-testid="engrave-repair-height-note">
                          {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                          <button
                            type="button"
                            className="op-toggle-btn"
                            style={{ marginTop: 8 }}
                            onClick={() => {
                              setEngraveRepairConfirmed(true)
                              setHeightRepairMessage(null)
                            }}
                          >{tx('NewOperationModalBody.Use_the_current_paths_and_depth_policy')}</button>
                        </div>
                      ) : (
                        <div style={{ marginTop: 6 }}>
                          <div className="op-toggle-row" style={{ marginBottom: 8 }} data-testid="engrave-depth-follows">
                            <button
                              type="button"
                              className={`op-toggle-btn ${!engraveFollowSurface ? 'op-toggle-active' : ''}`}
                              aria-pressed={!engraveFollowSurface}
                              data-testid="engrave-flat-depth"
                              onClick={() => setEngraveFollowSurface(false)}
                            >{tx('NewOperationModalBody.Flat_depth')}</button>
                            <button
                              type="button"
                              className={`op-toggle-btn ${engraveFollowSurface ? 'op-toggle-active' : ''}`}
                              aria-pressed={engraveFollowSurface}
                              data-testid="engrave-follow-surface"
                              onClick={() => setEngraveFollowSurface(true)}
                            >{tx('NewOperationModalBody.Follow_the_surface')}</button>
                          </div>
                          {engraveFollowSurface && (
                            <div className="op-hint" data-testid="engrave-follow-surface-note">{tx('NewOperationModalBody.Every_point_cuts_the_depth_below_the_part_surface')}</div>
                          )}
                          {!engrave.useWidthForDepth && (
                            <div
                              onFocusCapture={() => { engraveDepthDraftEdited.current = false }}
                              onChangeCapture={() => { engraveDepthDraftEdited.current = true }}
                              onKeyDownCapture={event => {
                                if (event.key === 'Escape') engraveDepthDraftEdited.current = false
                              }}
                              onBlur={event => {
                                // NumericInput omits onChange for a retyped identical value.
                                // A valid, committed entry still supplies the operator's intent.
                                if (engraveDepthDraftEdited.current && event.target instanceof HTMLInputElement &&
                                    Number.isFinite(parseFloat(event.target.value))) setEngraveDepthEntered(true)
                                engraveDepthDraftEdited.current = false
                              }}
                            >
                              <NumberField
                                label={tx('NewOperationModalBody.Engraving_depth')} unit="mm" units={displayUnits}
                                value={engraveExplicitDepthMm} min={0.001} step={0.1}
                                onChange={value => {
                                  setEngraveExplicitDepthMm(value)
                                  // WO-2636: entering the depth supplies intent; no second tick box.
                                  // Keep the state hook's explicit-end contract for starting policy.
                                  setEngraveDepthEntered(true)
                                }}
                              />
                            </div>
                          )}
                          <LiveSmartHeightPlan
                            preview={engraveHeightPreview}
                            idleMessage={!engrave.useWidthForDepth && !engraveDepthEntered
                              ? tx('NewOperationModalBody.Enter_the_depth_to_run_Smart_Height_preflight')
                              : tx('NewOperationModalBody.Select_at_least_one_path_and_a_tool_to')}
                            repairMessage={heightRepairMessage}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {isVCarve && (
                    <div className="op-pass-summary" data-testid="vcarve-height-policy" style={{ marginTop: 10 }}>
                      <strong>{tx('NewOperationModalBody.Smart_carve_depth')}</strong>
                      {vcarveHeightAuthority === 'repair_required' ? (
                        <div className="op-hint op-hint-warn" data-testid="vcarve-repair-height-note">
                          {SMART_HEIGHT_V2_REPAIR_MESSAGE}
                          <button
                            type="button"
                            className="op-toggle-btn"
                            style={{ marginTop: 8 }}
                            onClick={() => {
                              setVCarveRepairConfirmed(true)
                              setHeightRepairMessage(null)
                            }}
                          >{tx('NewOperationModalBody.Use_the_current_outlines_and_depth_policy')}</button>
                        </div>
                      ) : (
                        <div style={{ marginTop: 6 }}>
                          <LiveSmartHeightPlan
                            preview={vcarveHeightPreview}
                            idleMessage={tx('NewOperationModalBody.Select_at_least_one_closed_outline_and_a_V')}
                            repairMessage={heightRepairMessage}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {refGovernsTop && !isThreadMill && !isEngrave && !isVCarve && (
                    <NumberField label={tx('NewOperationModalBody.Bottom_of_cut_Z')} unit="mm" units={displayUnits}
                      value={heights.bottomHeight} step={0.5}
                      onChange={v => editNumericHeight('bottom', v, {
                        bottomHeight: v, bottomHeightMode: 'absolute', selectedFaceZ: undefined, bottomManual: true,
                      })}
                    />
                  )}
                </>
              ))}
              </div>
              {/* WO-1974: the diagram lives OUTSIDE the policy-controls div above, which is
                  `hidden` until Top/Bottom is expanded - inside it the diagram never showed.
                  Drawn for every op with heights (Adaptive 3D and an unresolved Face too: it
                  falls back to the rows' own values until the plan resolves). */}
              <div data-testid="operation-height-diagram" style={{ gridRow: 7 }}>
                <HeightDiagram
                  heights={diagramHeights}
                  units={displayUnits}
                  topOverride={
                    isFace && faceHeightPreview.state === 'resolved'
                      ? faceHeightPreview.plan.machining.materialStart.wcsMm
                    : isContour && contourHeightPreview.state === 'resolved'
                      ? contourHeightPreview.plan.machining.materialStart.wcsMm
                    : (isDrill || isBore) && drillBoreHeightPreview.state === 'resolved'
                      ? drillBoreHeightPreview.plan.machining.materialStart.wcsMm
                    : isEngrave && engraveHeightPreview.state === 'resolved'
                      ? engraveHeightPreview.plan.machining.materialStart.wcsMm
                    : isVCarve && vcarveHeightPreview.state === 'resolved'
                      ? vcarveHeightPreview.plan.machining.materialStart.wcsMm
                    : isThreadMill && threadMillHeightPreview.state === 'resolved'
                      ? threadMillHeightPreview.plan.machining.materialStart.wcsMm
                    : refSupported && refGovernsTop && opHeightReference !== 'absolute'
                      ? refResolvedZ : standardResolvedWcs('top')
                  }
                  bottomOverride={
                    isFace && faceHeightPreview.state === 'resolved'
                      ? resolvedPlanTargetEndWcs(faceHeightPreview.plan)
                    : isContour && contourHeightPreview.state === 'resolved'
                      ? resolvedPlanTargetEndWcs(contourHeightPreview.plan)
                    : (isDrill || isBore) && drillBoreHeightPreview.state === 'resolved'
                      ? resolvedPlanTargetEndWcs(drillBoreHeightPreview.plan)
                    : isThreadMill && threadMillHeightPreview.state === 'resolved'
                      ? resolvedPlanTargetEndWcs(threadMillHeightPreview.plan)
                    : isEngrave && engraveHeightPreview.state === 'resolved'
                      ? resolvedPlanTargetEndWcs(engraveHeightPreview.plan)
                    : isVCarve && vcarveHeightPreview.state === 'resolved'
                      ? resolvedPlanTargetEndWcs(vcarveHeightPreview.plan)
                    : refSupported && !refGovernsTop
                      && opHeightReference !== 'absolute'
                      && heights.bottomHeightMode !== 'selected_face'
                      ? refResolvedZ
                      // Pocket carries its OWN bottom-of-cut reference (not in the
                      // shared refSupported set). Show the RESOLVED plane (reference +
                      // offset = where the cut actually lands) instead of the stale
                      // legacy heights.bottomHeight (default -5), which the diagram
                      // would otherwise echo even when "Geometry + 0" sits the cut on
                      // the lines (Operator ruling 2026-06-13: "where did it get 5mm from?").
                      : isPocket
                        && (pocket.heightReference ?? 'stock_top') !== 'absolute'
                        && heights.bottomHeightMode !== 'selected_face'
                      ? resolveRefZ(pocket.heightReference ?? 'stock_top', pocket.planeOffset ?? 0, geoId)
                      : standardResolvedWcs('bottom')
                  }
                />
              </div>
            </div>
          )}

          {/* ── Feedrate Override ────────────────────────────────────────── */}
          {tab === 'feedrate' && (() => {
            const machine = project.machine
            const maxXY   = machine.axisLimits?.x.maxCutting ?? machine.rapidRate
            const maxZ    = machine.axisLimits?.z.maxCutting ?? machine.rapidRate
            const patchFO = (updates: Partial<FeedrateOverride>) =>
              setFeedrateOverride(prev => ({ ...prev, ...updates }))
            return (
              <div className="op-tab-content">

                <label className="op-check-label op-check-label-lg" style={{ marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={feedrateOverride.enabled}
                    onChange={e => {
                      const enabling = e.target.checked
                      if (enabling) {
                        setFeedrateOverride(prev => ({ ...prev, enabled: true }))
                      } else {
                        patchFO({ enabled: false })
                      }
                    }}
                  />
                  <span>{tx('NewOperationModalBody.Override_tool_feeds_speeds_for_this_operation')}</span>
                </label>

                {/* UI-BRAND-B2-8: same shared empty-state treatment the
                    Geometry tab already uses (.op-no-tool-notice) for its
                    "nothing to show yet" case, so this tab stops going
                    blank below the checkbox when there is no tool picked
                    yet (or the picked tool has no saved feed & speed
                    defaults) to preview. Purely additive -- the read-only
                    defaults grid just below is unchanged. */}
                {!feedrateOverride.enabled && !selectedTool?.feedsAndSpeeds?.default && (
                  <div className="op-no-tool-notice">
                    <Gauge size={28} />
                    <span className="op-no-tool-title">{tx('NewOperationModalBody.No_feed_speed_defaults_yet')}</span>
                    <span className="op-no-tool-body">
                      {selectedTool
                        ? tx('NewOperationModalBody.This_tool_has_no_saved_feed_speed_defaults_Add')
                        : tx('NewOperationModalBody.Select_a_tool_on_the_Tool_tab_to_preview')}
                    </span>
                  </div>
                )}

                {!feedrateOverride.enabled && selectedTool?.feedsAndSpeeds?.default && (() => {
                  const f = selectedTool.feedsAndSpeeds.default
                  return (
                    <div className="fo-readonly-grid">
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Spindle_speed')}</span><span className="fo-ro-val">{tx('NewOperationModalBody.RPM_2', { p1: f.rpm.toLocaleString() })}</span></div>
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Cutting_feed')}</span><span className="fo-ro-val">{fmtFeed(f.feedRate, displayUnits)} {feedLabel(displayUnits)}</span></div>
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Plunge_feed')}</span><span className="fo-ro-val">{fmtFeed(f.plungeRate, displayUnits)} {feedLabel(displayUnits)}</span></div>
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Ramp_feed')}</span><span className="fo-ro-val">{fmtFeed(f.rampFeedrate ?? Math.round(f.plungeRate * 1.5), displayUnits)} {feedLabel(displayUnits)}</span></div>
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Lead_in_feed')}</span><span className="fo-ro-val">{fmtFeed(f.leadInFeedrate ?? f.feedRate, displayUnits)} {feedLabel(displayUnits)}</span></div>
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Lead_out_feed')}</span><span className="fo-ro-val">{fmtFeed(f.leadOutFeedrate ?? f.feedRate, displayUnits)} {feedLabel(displayUnits)}</span></div>
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Fast_traverse_feed')}</span><span className="fo-ro-val">{fmtFeed(Math.min(f.fastTraverseFeedrate ?? machine.rapidRate, machine.rapidRate), displayUnits)} {feedLabel(displayUnits)}</span></div>
                      <div className="fo-ro-row"><span className="fo-ro-label">{tx('NewOperationModalBody.Finish_feed')}</span><span className="fo-ro-val">{fmtFeed(f.finishFeedrate ?? f.feedRate, displayUnits)} {feedLabel(displayUnits)}</span></div>
                    </div>
                  )
                })()}

                {feedrateOverride.enabled && (
                  <>
                    <p className="op-section-label">{tx('NewOperationModalBody.Spindle')}</p>
                    <NumberField
                      label={tx('NewOperationModalBody.Spindle_speed')} unit="RPM"
                      value={feedrateOverride.rpm}
                      min={machine.minSpindleRpm ?? 0} max={machine.maxSpindleRpm} step={100}
                      onChange={v => patchFO({ rpm: v })}
                    />

                    <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Feedrates', { p1: feedLabel(displayUnits) })}</p>
                    <NumberField
                      label={tx('NewOperationModalBody.Cutting_feed')} unit="mm/min" units={displayUnits} kind="feed"
                      value={feedrateOverride.feedRate}
                      min={1} max={maxXY} step={50}
                      onChange={v => patchFO({ feedRate: v })}
                    />
                    <NumberField
                      label={tx('NewOperationModalBody.Lead_in_feed')} unit="mm/min" units={displayUnits} kind="feed"
                      value={feedrateOverride.leadInFeedrate}
                      min={1} max={maxXY} step={50}
                      onChange={v => patchFO({ leadInFeedrate: v })}
                    />
                    <NumberField
                      label={tx('NewOperationModalBody.Lead_out_feed')} unit="mm/min" units={displayUnits} kind="feed"
                      value={feedrateOverride.leadOutFeedrate}
                      min={1} max={maxXY} step={50}
                      onChange={v => patchFO({ leadOutFeedrate: v })}
                    />
                    <NumberField
                      label={tx('NewOperationModalBody.Fast_traverse_feed')} unit="mm/min" units={displayUnits} kind="feed"
                      value={feedrateOverride.fastTraverseFeedrate}
                      min={1} max={machine.rapidRate} step={50}
                      onChange={v => patchFO({ fastTraverseFeedrate: v })}
                    />
                    <NumberField
                      label={tx('NewOperationModalBody.Finish_feed')} unit="mm/min" units={displayUnits} kind="feed"
                      value={feedrateOverride.finishFeedrate ?? feedrateOverride.feedRate}
                      min={1} max={maxXY} step={50}
                      onChange={v => patchFO({ finishFeedrate: v })}
                    />
                    <NumberField
                      label={tx('NewOperationModalBody.Ramp_feed')} unit="mm/min" units={displayUnits} kind="feed"
                      value={feedrateOverride.rampFeedrate}
                      min={1} max={maxXY} step={50}
                      onChange={v => patchFO({ rampFeedrate: v })}
                    />

                    <p className="op-section-label" style={{ marginTop: 12 }}>{tx('NewOperationModalBody.Vertical')}</p>
                    <NumberField
                      label={tx('NewOperationModalBody.Plunge_feed')} unit="mm/min" units={displayUnits} kind="feed"
                      value={feedrateOverride.plungeRate}
                      min={1} max={maxZ} step={25}
                      onChange={v => patchFO({ plungeRate: v })}
                    />
                  </>
                )}
              </div>
            )
          })()}

          {/* ── Linking ──────────────────────────────────────────────────── */}
          {/* parallel_3d has no Linking tab (filtered from the nav) and reads no
              op.linking; guard the content too in case the tab state lingers.
              thread_mill reads no op.linking either (BUG-413). */}
          {tab === 'linking' && !isParallel3d && !isSteepShallow3d && !isScallop3d && !isPencil3d && !isAdaptive3d && !isThreadMill && (
            <div className="op-tab-content">

              {/* Drill — only between-hole retract height matters */}
              {isDrill && (
                <>
                  <p className="op-section-label">{tx('NewOperationModalBody.Between_hole_retract')}</p>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${drill.retractMode === 'clearance' ? 'op-toggle-active' : ''}`}
                      onClick={() => setDrill(d => ({ ...d, retractMode: 'clearance' }))}
                    >{tx('NewOperationModalBody.Clearance_height')}</button>
                    <button
                      className={`op-toggle-btn ${drill.retractMode === 'retract' ? 'op-toggle-active' : ''}`}
                      onClick={() => setDrill(d => ({ ...d, retractMode: 'retract' }))}
                    >{tx('NewOperationModalBody.Retract_height')}</button>
                  </div>
                </>
              )}

              {!isDrill && (
              <>
              <p className="op-section-label">{tx('NewOperationModalBody.Entry_type')}</p>

              {isBore ? (
                <>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${linking.entryType === 'ramp_helical' ? 'op-toggle-active' : ''}`}
                      onClick={() => setLinking(l => ({ ...l, entryType: 'ramp_helical' }))}
                    >{tx('NewOperationModalBody.Helix')}</button>
                    <button
                      className={`op-toggle-btn ${linking.entryType === 'plunge' ? 'op-toggle-active' : ''}`}
                      onClick={() => setLinking(l => ({ ...l, entryType: 'plunge' }))}
                    >{tx('NewOperationModalBody.Plunge')}</button>
                  </div>
                  {linking.entryType === 'ramp_helical' && (
                    <NumberField label={tx('NewOperationModalBody.Ramp_angle')} unit="deg"
                      value={linking.rampAngle} min={0.5} max={30} step={0.5}
                      onChange={v => setLinking(l => ({ ...l, rampAngle: v }))} />
                  )}
                </>
              ) : isPocket ? (
                <>
                  {(() => {
                    const policy = getPocketEntryPolicy(pocket.fillStrategy)
                    return (
                      <>
                        <div className="op-toggle-row">
                          {policy.allowed.map((entryType) => (
                            <button
                              key={entryType}
                              className={`op-toggle-btn ${linking.entryType === entryType ? 'op-toggle-active' : ''}`}
                              onClick={() => setLinking(l => ({ ...l, entryType }))}
                            >{tx(`choices.POCKET_ENTRY_LABELS.${entryType}`)}</button>
                          ))}
                        </div>
                        {!isPocketEntryAllowed(pocket.fillStrategy, linking.entryType) && (
                          <span className="op-hint op-hint-warn" data-testid="pocket-entry-invalid">{tx('NewOperationModalBody.Saved_entry_is_incompatible_with_this_fill_strategy_Choose', { p1: linking.entryType })}{policy.allowed.map((entry) => tx(`choices.POCKET_ENTRY_LABELS.${entry}`)).join(tx('NewOperationModalBody.Census_or'))}{tx('NewOperationModalBody.symbol_2')}</span>
                        )}
                      </>
                    )
                  })()}

                  {linking.entryType === 'ramp_helical' && (
                    <NumberField label={tx('NewOperationModalBody.Helix_diameter')} unit={tx('NewOperationModalBody.Percent_tool_diameter')}
                      value={pocket.helixDiameter} min={10} max={95} step={5}
                      onChange={v => setPocket(p => ({ ...p, helixDiameter: v }))}
                    />
                  )}

                  {(linking.entryType === 'ramp_helical' || linking.entryType === 'ramp_linear') && (
                    <NumberField label={tx('NewOperationModalBody.Ramp_angle')} unit="°"
                      value={linking.rampAngle} min={0.5} max={30} step={0.5}
                      onChange={v => setLinking(l => ({ ...l, rampAngle: v }))}
                    />
                  )}

                  {linking.entryType === 'ramp_helical' && (
                    <NumberField label={tx('NewOperationModalBody.Helix_start_above_material')} unit="mm" units={displayUnits}
                      value={pocket.entryClearance ?? 1} min={0} step={0.5}
                      onChange={v => setPocket(p => ({ ...p, entryClearance: v }))}
                    />
                  )}
                </>
              ) : isAdaptive ? (
                <>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${linking.entryType !== 'plunge' ? 'op-toggle-active' : ''}`}
                      onClick={() => setLinking(l => ({ ...l, entryType: 'ramp_helical' }))}
                    >{tx('NewOperationModalBody.Helix')}</button>
                    <button
                      className={`op-toggle-btn ${linking.entryType === 'plunge' ? 'op-toggle-active' : ''}`}
                      onClick={() => setLinking(l => ({ ...l, entryType: 'plunge' }))}
                    >{tx('NewOperationModalBody.Plunge')}</button>
                  </div>

                  {linking.entryType !== 'plunge' && (
                    <>
                      <NumberField label={tx('NewOperationModalBody.Helix_diameter')} unit={tx('NewOperationModalBody.Percent_tool_diameter')}
                        value={adaptive.helixDiameter ?? 90} min={10} max={95} step={5}
                        onChange={v => setAdaptive(a => ({ ...a, helixDiameter: v }))}
                      />
                      <NumberField label={tx('NewOperationModalBody.Ramp_angle')} unit="°"
                        value={adaptive.rampAngle} min={0.5} max={30} step={0.5}
                        onChange={v => setAdaptive(a => ({ ...a, rampAngle: v }))}
                      />
                      <NumberField label={tx('NewOperationModalBody.Minimum_helix_radius')} unit="mm" units={displayUnits}
                        value={adaptive.minHelixRadius ?? 0.2} min={0.01} max={50} step={0.01}
                        onChange={v => setAdaptive(a => ({ ...a, minHelixRadius: v }))}
                      />
                    </>
                  )}

                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Stay_down')}</p>
                  <label className="op-check-label">
                    <input
                      type="checkbox"
                      checked={adaptive.integralWallFollow ?? false}
                      onChange={e => setAdaptive(a => ({ ...a, integralWallFollow: e.target.checked }))}
                    />
                    <span>{tx('NewOperationModalBody.Integral_wall_follow')}</span>
                  </label>
                  {(adaptive.integralWallFollow ?? false) && (
                    <NumberField label={tx('NewOperationModalBody.Maximum_direct_wall_ride')} unit={tx('NewOperationModalBody.Percent_straight_distance')}
                      value={(
                        Number.isFinite(adaptive.integralWallFollowLengthFactor)
                        && (adaptive.integralWallFollowLengthFactor ?? 0) > 0
                          ? adaptive.integralWallFollowLengthFactor!
                          : 2
                      ) * 100}
                      min={10} max={1000} step={10}
                      onChange={v => setAdaptive(a => ({
                        ...a,
                        integralWallFollowLengthFactor: Number.isFinite(v) && v > 0 ? v / 100 : 2,
                      }))}
                    />
                  )}
                  <label className="op-check-label">
                    <input
                      type="checkbox"
                      checked={adaptive.wallCleanupAsWeGo ?? false}
                      onChange={e => setAdaptive(a => ({ ...a, wallCleanupAsWeGo: e.target.checked }))}
                    />
                    <span>{tx('NewOperationModalBody.Wall_cleanup_as_we_go_integrated_finishing')}</span>
                  </label>
                  {(adaptive.wallCleanupAsWeGo ?? false) && (
                    <NumberField label={tx('NewOperationModalBody.Loopback_fillet')} unit={tx('NewOperationModalBody.Percent_tool_radius')}
                      value={adaptive.loopbackFilletPct ?? 25} min={5} max={100} step={5}
                      onChange={v => setAdaptive(a => ({ ...a, loopbackFilletPct: v }))}
                    />
                  )}
                  <label className="op-check-label">
                    <input
                      type="checkbox"
                      checked={adaptive.wallFinish ?? false}
                      onChange={e => setAdaptive(a => ({ ...a, wallFinish: e.target.checked }))}
                    />
                    <span>{tx('NewOperationModalBody.Final_wall_cleanup')}</span>
                  </label>
                  {(adaptive.wallFinish ?? false) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                      <label className="op-field-label">{tx('NewOperationModalBody.Wall_finish_depth')}</label>
                      <select
                        className="mform-select"
                        data-testid="op-adaptive-wall-finish-mode"
                        value={adaptive.wallFinishMode ?? 'final'}
                        onChange={e => setAdaptive(a => ({ ...a, wallFinishMode: e.target.value as 'final' | 'each_stepdown' | 'final_to_size' }))}
                      >
                        <option value="final">{tx('NewOperationModalBody.At_final_depth_leaves_stock_to_leave_standing')}</option>
                        <option value="each_stepdown">{tx('NewOperationModalBody.At_each_stepdown_leaves_stock_to_leave_standing')}</option>
                        <option value="final_to_size">{tx('NewOperationModalBody.Finish_pass_at_final_depth_cuts_to_size')}</option>
                      </select>
                      <div data-testid="op-adaptive-finish-lead-in-radius">
                        <NumberField label={tx('NewOperationModalBody.Wall_finish_lead_in_radius')} unit="mm" units={displayUnits}
                          value={linking.leadInRadius} min={0} max={50} step={0.5}
                          onChange={v => setLinking(l => ({ ...l, leadInRadius: v }))}
                        />
                      </div>
                      <div data-testid="op-adaptive-finish-lead-out-radius">
                        <NumberField label={tx('NewOperationModalBody.Wall_finish_lead_out_radius')} unit="mm" units={displayUnits}
                          value={linking.leadOutRadius} min={0} max={50} step={0.5}
                          onChange={v => setLinking(l => ({ ...l, leadOutRadius: v }))}
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : isContour && contourPathType === 'open' ? (
                <>
                  <div className="op-toggle-row" data-testid="contour-open-entry-type">
                    <button className="op-toggle-btn op-toggle-active" disabled>
                      {tx('NewOperationModalBody.Plunge_outside_stock')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {isChamfer && (
                    <div data-testid="chamfer-entry-policy">
                      <p className="op-section-label">{tx('NewOperationModalBody.Chamfer_entry_policy')}</p>
                      <select
                        aria-label={tx('NewOperationModalBody.Chamfer_entry_policy')}
                        value={chamfer.entryPolicy ?? 'authored'}
                        onChange={e => setChamfer(c => ({ ...c, entryPolicy: e.target.value as 'authored' | 'clear_space' }))}
                      >
                        <option value="authored">{tx('NewOperationModalBody.Chamfer_authored_entry')}</option>
                        <option value="clear_space">{tx('NewOperationModalBody.Chamfer_clear_space_entry')}</option>
                      </select>
                      {chamfer.entryPolicy === 'clear_space' && <p className="op-hint">{tx('NewOperationModalBody.Chamfer_clear_space_description')}</p>}
                    </div>
                  )}
                  {!(isChamfer && chamfer.entryPolicy === 'clear_space') && (<>
                  <div className="op-toggle-row">
                    <button
                      className={`op-toggle-btn ${linking.entryType === 'plunge' ? 'op-toggle-active' : ''}`}
                      onClick={() => setLinking(l => ({ ...l, entryType: 'plunge' }))}
                    >{tx('NewOperationModalBody.Plunge')}</button>
                    <button
                      className={`op-toggle-btn ${linking.entryType === 'ramp_linear' ? 'op-toggle-active' : ''}`}
                      onClick={() => setLinking(l => ({ ...l, entryType: 'ramp_linear' }))}
                    >{tx('NewOperationModalBody.Ramp_linear')}</button>
                  </div>

                  {linking.entryType === 'ramp_linear' && (
                    <NumberField label={tx('NewOperationModalBody.Ramp_angle')} unit="°"
                      value={linking.rampAngle} min={0.5} max={30} step={0.5}
                      onChange={v => setLinking(l => ({ ...l, rampAngle: v }))}
                    />
                  )}
                  </>)}

                  {contourPathType === 'closed' && (
                  <>
                  <p className="op-section-label" style={{ marginTop: 14 }}>{tx('NewOperationModalBody.Tabs')}</p>
                  <label className="op-check-label op-check-label-lg">
                    <input
                      type="checkbox"
                      data-testid="contour-tabs-enabled"
                      checked={contour.tabs}
                      onChange={e => {
                        const enabled = e.target.checked
                        setContour(c => ({ ...c, tabs: enabled }))
                      }}
                    />
                    <span>{tx('NewOperationModalBody.Hold_the_part_with_tabs')}</span>
                  </label>
                  {contour.tabs && (
                    <div data-testid="contour-tab-controls">
                      <NumberField
                        label={tx('NewOperationModalBody.Tab_width')}
                        unit="mm"
                        units={displayUnits}
                        value={contour.tabWidth ?? DEFAULT_CONTOUR_TABS.width}
                        min={0.1}
                        step={0.5}
                        onChange={v => setContour(c => ({ ...c, tabWidth: v }))}
                      />
                      <NumberField
                        label={tx('NewOperationModalBody.Tab_height')}
                        unit="mm"
                        units={displayUnits}
                        value={contour.tabHeight ?? DEFAULT_CONTOUR_TABS.height}
                        min={0.1}
                        step={0.5}
                        onChange={v => setContour(c => ({ ...c, tabHeight: v }))}
                      />
                      <NumberField
                        label={tx('NewOperationModalBody.Tab_count')}
                        unit=""
                        value={contour.tabCount ?? DEFAULT_CONTOUR_TABS.count}
                        min={1}
                        max={50}
                        step={1}
                        onChange={v => setContour(c => ({ ...c, tabCount: Math.round(v) }))}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                        <label className="op-field-label">{tx('NewOperationModalBody.Tab_shape')}</label>
                        <select
                          className="mform-select"
                          data-testid="contour-tab-shape"
                          value={contour.tabShape ?? 'box'}
                          onChange={e => setContour(c => ({ ...c, tabShape: e.target.value as 'box' | 'triangular' }))}
                        >
                          <option value="box">{tx('NewOperationModalBody.Box')}</option>
                          <option value="triangular">{tx('NewOperationModalBody.Triangular_ramped')}</option>
                        </select>
                      </div>
                    </div>
                  )}
                  </>
                  )}
                </>
              )}
              </>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="modal-btn modal-btn-ghost" onClick={handleClose}>{tx('NewOperationModalBody.Cancel_2')}</button>
          <button
            className="modal-btn modal-btn-primary"
            data-testid="op-create"
            onClick={handleCreate}
            disabled={!canCreate}
            data-tooltip={
              authoring.message
            }
          >
            {isEditMode ? tx('NewOperationModalBody.Save_Recompute') : tx('NewOperationModalBody.Create_Operation')}
          </button>
        </div>

      </div>
    </div>
    {loopPickBanner}
    </>
  )
}
