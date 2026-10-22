import { textFor } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { resolveOpGeometrySources, setupProvenStockId, smartHeightModelTop, useCamStore } from '../../store'
import { DEFAULT_ADAPTIVE3D_PARAMS, type Adaptive3dParams } from '../../cam3d/integration/adaptive3dOperation'
import { DEFAULT_PARALLEL3D_PARAMS, type Parallel3dParams } from '../../cam3d/integration/parallel3dOperation'
import { DEFAULT_WATERLINE_PARAMS, type WaterlineParams } from '../../cam3d/integration/waterline3dOperation'
import { DEFAULT_STEEP_SHALLOW3D_PARAMS, type SteepShallow3dParams } from '../../cam3d/integration/steepShallow3dOperation'
import { DEFAULT_SCALLOP3D_PARAMS, type Scallop3dParams } from '../../cam3d/integration/scallop3dOperation'
import { DEFAULT_PENCIL3D_PARAMS, type Pencil3dParams } from '../../cam3d/integration/pencil3dOperation'
import {
  DEFAULT_REST_MACHINING_SETTINGS,
  readRestMachiningSettings,
  restMachiningAvailability,
  type RestMachiningSettings,
} from '../../cam3d/integration/rest3dOperation'
import { normalizePocketEntryForFillStrategy } from '../../lib/cam/pocketEntryPolicy'
import { normalizeLoopSelection } from '../../lib/cam/meshChainInstances'
import { deriveContourMode } from '../../lib/cam/types'
import type {
  ACParams, BoreParams, ChamferParams, ContourCuttingStrategy, ContourParams,
  DrillParams, EngraveParams, FaceParams, PocketParams, ThreadMillParams, VCarveParams,
} from '../../lib/cam/types'
import type { CylinderFeature, FeedrateOverride, HeightParams, LinkingParams, Loop2D, MachineActionKind, OperationType, PassParams, Tool } from '../../types'
import { setupDefaultHeightIntent } from '../../lib/cam/heightIntent'
import { uiReferenceForIntentReference } from '../../lib/cam/heightReference'
import {
  adaptive3dHeightDraftFromIntent,
  chamferSmartHeightDraftFromIntent,
  contourSmartHeightDraftFromIntent,
  deriveContourFeatureBindings,
  deriveDrillBoreFeatureBindings,
  drillBoreSmartHeightDraftFromIntent,
  engraveSmartHeightDraftFromIntent,
  vcarveSmartHeightDraftFromIntent,
  faceSmartHeightDraftFromIntent,
  parallel3dHeightDraftFromIntent,
  steepShallow3dHeightDraftFromIntent,
  scallop3dHeightDraftFromIntent,
  pencil3dHeightDraftFromIntent,
  waterline3dHeightDraftFromIntent,
  SMART_HEIGHT_V2_REPAIR_MESSAGE,
  validatePersistedSmartHeightState,
  type Adaptive3dHeightDraft,
  type ContourSmartHeightDraft,
  type DrillBoreSmartHeightDraft,
  type FaceSmartHeightDraft,
} from '../../lib/cam/smartHeights'
import {
  deriveOperationHeightDraft,
  selectStartingHeightPolicy,
  type LiveSmartHeightOperationType,
} from '../../lib/cam/newOperationHeightDefaults'
import type { VpHandle } from '../panels/DesignTree'
import {
  defaultACParams, defaultBoreParams, defaultChamferParams, defaultContourParams,
  defaultDrillParams, defaultEngraveParams, defaultFaceParams, defaultFeedrateOverride,
  defaultHeights, defaultLinking, defaultPasses, defaultPocketParams,
  defaultThreadMillParams, defaultVCarveParams, getVp, type Tab,
} from './newOperationModalDefaults'
import { finishMachiningBoundaryPickPresentation } from './newOperationMachiningBoundaryPickPresentation'

// ── State hook ────────────────────────────────────────────────────────────────
// BK-178-DECOMP: every useState/useEffect/useRef/store subscription for the
// wizard lives HERE, in one custom hook called unconditionally at the top of the
// thin wrapper above. The wrapper's early return renders <NewOperationModalBody/>
// -- a separate component that receives fully resolved values as props and calls
// NO hooks of its own -- so there is structurally no place below an early return
// for a hook to land. That eliminates the BK-178 hooks-order hazard class at the
// source (coordination/reports/BK-178.report.md): the old "HOOK BOUNDARY" comment
// enforced this by convention; the module split now enforces it by construction.
import type { OpPayloadByType } from '../../store/opGeometryFieldContract'

/** An operation's stored `params` (untyped on the wire) read as the payload its
 *  own family carries. The key ties the result to `OpPayloadByType`, so a
 *  setter fed the wrong family's payload is a compile error. */
function payloadOf<K extends OperationType>(_type: K, params: Record<string, unknown>): OpPayloadByType[K] {
  return params as unknown as OpPayloadByType[K]
}

/** WO-2211: the tool record's library stepover (mm), read from the same entry
 *  defaultFeedrateOverride seeds feeds from ('default', else the first material);
 *  undefined when the tool has none. */
function libraryStepoverMm(tool: Pick<Tool, 'feedsAndSpeeds'>): number | undefined {
  const entry = tool.feedsAndSpeeds?.['default']
    ?? (tool.feedsAndSpeeds ? Object.values(tool.feedsAndSpeeds)[0] : undefined)
  const stepover = entry?.stepover
  return typeof stepover === 'number' && Number.isFinite(stepover) && stepover > 0 ? stepover : undefined
}

/** WO-2859: a chain family's draft setter that keeps its STL instance
 *  bindings inside its picks (meshChainInstances.ts). Stable identity. */
function useLoopSelectionSetter<T extends { geometryId?: string; loopIds?: string[] }>(
  setDraft: Dispatch<SetStateAction<T>>,
): Dispatch<SetStateAction<T>> {
  return useCallback((update: SetStateAction<T>) => setDraft((previous) =>
    normalizeLoopSelection(typeof update === 'function' ? (update as (prev: T) => T)(previous) : update)), [setDraft])
}

export function useNewOperationModalState() {
  const activeModal      = useCamStore(s => s.activeModal)
  const closeModal       = useCamStore(s => s.closeModal)
  const project          = useCamStore(s => s.project)
  // Tool library is a ROOT slice (single source of truth), not project-scoped.
  const toolLibrary      = useCamStore(s => s.toolLibrary)
  // OP-TOOL-FILTER: named libraries a tool may belong to (Tool.libraryId) --
  // the library facet reuses this SAME slice ToolLibraryModal's library
  // selector reads, so a library renamed/added there shows up here too.
  const toolLibraries    = useCamStore(s => s.toolLibraries)
  const addOperation     = useCamStore(s => s.addOperation)
  const updateOperation  = useCamStore(s => s.updateOperation)
  const editingOpPayload = useCamStore(s => s.editingOpPayload)
  const computeToolpath  = useCamStore(s => s.computeOperationToolpath)
  const previewAdaptive3dSmartHeights = useCamStore(s => s.previewAdaptive3dSmartHeights)
  const previewParallel3dSmartHeights = useCamStore(s => s.previewParallel3dSmartHeights)
  const previewWaterline3dSmartHeights = useCamStore(s => s.previewWaterline3dSmartHeights)
  const previewFaceSmartHeights = useCamStore(s => s.previewFaceSmartHeights)
  const previewPlanarRoughSmartHeights = useCamStore(s => s.previewPlanarRoughSmartHeights)
  const previewContourSmartHeights = useCamStore(s => s.previewContourSmartHeights)
  const previewDrillBoreSmartHeights = useCamStore(s => s.previewDrillBoreSmartHeights)
  const previewThreadMillSmartHeights = useCamStore(s => s.previewThreadMillSmartHeights)
  const previewChamferSmartHeights = useCamStore(s => s.previewChamferSmartHeights)
  const previewEngraveSmartHeights = useCamStore(s => s.previewEngraveSmartHeights)
  const deriveBrepLayer  = useCamStore(s => s.deriveBrepLayer)
  const displayUnits     = useCamStore(s => s.appSettings.displayUnits)

  // WO-1903: the wizard's operation-type state IS the one OperationType union
  // (src/types), imported - not a hand-typed copy. Adding an operation type now
  // reaches this state without an edit here.
  const [tab,          setTab]          = useState<Tab>('type')
  const [opType,       setOpType]       = useState<OperationType>('contour_2d')
  // WO-2437: a Machine actions type chosen instead of a machining type (null = none).
  const [machineActionKind, setMachineActionKind] = useState<MachineActionKind | null>(null)
  const [opName,       setOpName]       = useState('')
  const [toolId,       setToolId]       = useState('')
  const [heights,      setHeights]      = useState<HeightParams>(defaultHeights)
  const [customEndCondition, setCustomEndCondition] = useState(false)
  const [passes,       setPasses]       = useState<PassParams>(defaultPasses)
  const [linking,      setLinking]      = useState<LinkingParams>(defaultLinking)
  // WO-2859: every draft write of a chain family (Contour, Pocket, Adaptive)
  // runs `normalizeLoopSelection`, so a per-instance STL binding can never
  // outlive its pick - whichever writer (Source change, Stock, path type,
  // reset, edit-open hydrate, row tick, viewport) last changed `loopIds`.
  const [contour,      setContourDraft] = useState<ContourParams>(defaultContourParams)
  const setContour = useLoopSelectionSetter(setContourDraft)
  const [contourHeightDraft, setContourHeightDraft] = useState<ContourSmartHeightDraft>({
    mode: 'selected_feature', explicitTargetWcsMm: -5, throughAllowanceMm: 0.5,
  })
  const [contourHeightAuthority, setContourHeightAuthority] = useState<'new' | 'smart_v2'>('new')
  const [pocket,       setPocketDraft]  = useState<PocketParams>(defaultPocketParams)
  const setPocket = useLoopSelectionSetter(setPocketDraft)
  const [drill,        setDrill]        = useState<DrillParams>(defaultDrillParams)
  const [bore,         setBore]         = useState<BoreParams>(defaultBoreParams)
  const [drillBoreHeightDraft, setDrillBoreHeightDraft] = useState<DrillBoreSmartHeightDraft>({
    mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5,
  })
  const [drillBoreHeightAuthority, setDrillBoreHeightAuthority] = useState<'new' | 'smart_v2'>('new')
  // WO-2516: a new Drill's Break through follows the holes it drills until the
  // operator sets it; an opened saved Drill keeps the value it was saved with.
  const [drillBreakthroughSetByUser, setDrillBreakthroughSetByUser] = useState(false)
  const [threadMill,   setThreadMill]   = useState<ThreadMillParams>(defaultThreadMillParams)
  const [chamfer,      setChamfer]      = useState<ChamferParams>(defaultChamferParams)
  const [face,         setFace]         = useState<FaceParams>(defaultFaceParams)
  const [engrave,      setEngrave]      = useState<EngraveParams>(defaultEngraveParams)
  const [engraveExplicitDepthMm, setEngraveExplicitDepthMm] = useState(1)
  const [engraveDepthConfirmed, setEngraveDepthConfirmed] = useState(false)
  // V-carve (WO-1174). vcarveClearingToolId names the separate end mill for
  // flat-clearing mode 'tool'; the dialog creates that sibling operation.
  const [vcarve,       setVCarve]       = useState<VCarveParams>(defaultVCarveParams)
  const [vcarveClearingToolId, setVCarveClearingToolId] = useState('')
  const [adaptive,     setAdaptiveDraft] = useState<ACParams>(defaultACParams)
  const setAdaptive = useLoopSelectionSetter(setAdaptiveDraft)
  // parallel_3d (3D finish): the raster params ride op.params; the source solid
  // (mesh/brep) is picked separately and stored as the single geometrySelection.
  const [parallel3d,   setParallel3d]   = useState<Parallel3dParams>(DEFAULT_PARALLEL3D_PARAMS)
  const [parallel3dPartId, setParallel3dPartId] = useState('')
  const [parallel3dHeightAuthority, setParallel3dHeightAuthority] =
    useState<'new' | 'smart_v2'>('new')
  // waterline_3d (constant-Z finish, WO-1176): same shape as parallel_3d - the
  // params ride op.params, the source solid is the single geometrySelection.
  const [waterline3d,  setWaterline3d]  = useState<WaterlineParams>(DEFAULT_WATERLINE_PARAMS)
  const [waterline3dPartId, setWaterline3dPartId] = useState('')
  const [waterline3dHeightAuthority, setWaterline3dHeightAuthority] =
    useState<'new' | 'smart_v2'>('new')
  const [steepShallow3d, setSteepShallow3d] =
    useState<SteepShallow3dParams>(DEFAULT_STEEP_SHALLOW3D_PARAMS)
  const [steepShallow3dPartId, setSteepShallow3dPartId] = useState('')
  const [scallop3d, setScallop3d] = useState<Scallop3dParams>(DEFAULT_SCALLOP3D_PARAMS)
  const [scallop3dPartId, setScallop3dPartId] = useState('')
  const [pencil3d, setPencil3d] = useState<Pencil3dParams>(DEFAULT_PENCIL3D_PARAMS)
  const [pencil3dPartId, setPencil3dPartId] = useState('')
  const [restMachining, setRestMachining] = useState<RestMachiningSettings>(DEFAULT_REST_MACHINING_SETTINGS)
  // adaptive_3d (3D rougher): the params ride op.params; the source solid
  // (mesh/brep) is picked separately and stored as the single geometrySelection.
  const [adaptive3d,   setAdaptive3d]   = useState<Adaptive3dParams>(DEFAULT_ADAPTIVE3D_PARAMS)
  const [adaptive3dPartId, setAdaptive3dPartId] = useState('')
  const [adaptive3dHeightDraft, setAdaptive3dHeightDraft] = useState<Adaptive3dHeightDraft>({
    mode: 'current_material', topWcsMm: 0, bottomWcsMm: -5,
  })
  const [adaptive3dHeightAuthority, setAdaptive3dHeightAuthority] = useState<'new' | 'smart_v2'>('new')
  const [faceHeightDraft, setFaceHeightDraft] = useState<FaceSmartHeightDraft>({
    mode: 'explicit_depth', explicitTargetWcsMm: -5,
  })
  const [faceHeightAuthority, setFaceHeightAuthority] = useState<'new' | 'smart_v2'>('new')
  const [faceHeightConfirmed, setFaceHeightConfirmed] = useState(false)
  const [isPickingSourcePart, setIsPickingSourcePart] = useState(false)
  const [isPickingLoops, setIsPickingLoops] = useState(false)
  // OP-TOOL-FILTER: Tool tab filter bar. Per-modal-open only (reset in the
  // activeModal-closes effect below) -- unlike ToolLibraryModal's search
  // (sticky across opens, a shop's persistent working view), this wizard
  // list is a one-shot picker each time the modal opens, so Operator's spec
  // calls for no persistence here.
  const [toolFilterSearch, setToolFilterSearch] = useState('')
  const [toolFilterUsedOnly, setToolFilterUsedOnly] = useState(false)
  const [toolFilterLibraryId, setToolFilterLibraryId] = useState<string | 'all'>('all')
  // Per-hole "review in viewport": clicking a hole's #N label highlights just
  // that hole's loop amber in the 3D view and yields the modal to a compact
  // banner so the user can SEE which hole it is, then return with form state
  // intact (the modal never unmounts). savedReviewPickedLoopIds snapshots the
  // op's current picked-loops set so Back/Esc can restore the viewport exactly.
  const [reviewingHoleLoopId, setReviewingHoleLoopId] = useState<string | null>(null)
  const [savedReviewPickedLoopIds, setSavedReviewPickedLoopIds] = useState<string[]>([])
  // Camera pose captured when a per-hole review STARTS, so Back/Esc restores the
  // prior view in addition to the picked-loops highlight. A ref (not state) — it
  // is an opaque viewport object, never rendered, and the cleanup effect reads it
  // without needing it in a dep array. null = no review camera saved.
  const savedReviewCameraRef = useRef<ReturnType<NonNullable<VpHandle['saveCameraState']>> | null>(null)
  // New operations begin with an explicit empty selection. The false state is
  // retained only while editing a legacy operation whose persisted empty
  // loopIds meant "all loops"; newly authored "All loops" choices materialize
  // every id instead of relying on that sentinel.
  const [userClearedLoops, setUserClearedLoops] = useState(true)

  // B-rep derive flow (Stage 4): viewport face/edge pick + busy/error surfacing
  // CAM-BINDING Stage 5: 'machining-boundary' added to the union - the SAME
  // modal-collapses-to-a-floating-banner mechanism the brep face/edge/datum
  // picks already use (found live, via a real-app headed-Playwright capture:
  // without collapsing, the modal's own centered dialog visually COVERS the
  // viewport, so a real canvas click can never reach the model at all - a
  // genuine product bug this stage's own acceptance test caught, not merely
  // a test-script workaround).
  const [brepPickKind,    setBrepPickKind]    = useState<'face' | 'edge' | 'datum' | 'face-target' | 'machining-boundary' | 'model-bore' | 'model-edge' | null>(null)
  const [brepFacePicks,   setBrepFacePicks]   = useState<number[]>([])
  // OCCT GeomAbs surface type per picked face index (1 = GeomAbs_Cylinder), reported
  // by the viewport face-pick callback. Drives the cylinder-vs-planar derive route.
  const [brepFaceTypes,   setBrepFaceTypes]   = useState<Record<number, number | undefined>>({})
  const [brepEdgePicks,   setBrepEdgePicks]   = useState<number[]>([])
  const [brepDeriving,    setBrepDeriving]    = useState<'face' | 'edges' | 'holes' | 'section' | null>(null)
  const [brepDeriveError, setBrepDeriveError] = useState<string | null>(null)
  // ADR-0003 (no silent fallbacks): when edit-prefill hits an OperationType with
  // no editor branch, this holds the user-visible failure message and the modal
  // renders an explicit error state instead of silently degrading to Contour UI.
  const [editLoadError, setEditLoadError] = useState<string | null>(null)
  const [heightRepairMessage, setHeightRepairMessage] = useState<string | null>(null)
  const [startingHeightPolicy, setStartingHeightPolicy] = useState(() =>
    selectStartingHeightPolicy('contour_2d', { hasSetupStock: false }),
  )
  // Multi-face pick with differing face depths: note which Z the bottom bound to.
  const [brepFaceDepthHint, setBrepFaceDepthHint] = useState<string | null>(null)
  // Section-at-Z input text; null = "untouched, use the model mid-height default".
  const [brepSectionZStr, setBrepSectionZStr] = useState<string | null>(null)
  // True while the user scrubs Section-at-Z in the viewport ("Set in viewport"):
  // the modal hides entirely — the viewport overlay carries its own Z readout,
  // typed input and Confirm/Cancel (same pattern as the pick-mode banners).
  const [isScrubbingSectionZ, setIsScrubbingSectionZ] = useState(false)

  const [feedrateOverride, setFeedrateOverride] = useState<FeedrateOverride>(defaultFeedrateOverride(undefined, project.machine.rapidRate))

  // CAM-BINDING Stage 5: the picked machining-boundary face on a modeled-body
  // source, local draft state exactly like heights/passes/loopIds above -
  // folded into modelReferences on Save for every supported profile binding
  // (contour, pocket, adaptive). null = no face picked (whole-body compute,
  // the existing default, or no source selected yet).
  const [machiningBoundaryFace, setMachiningBoundaryFace] = useState<{
    modelItemId?: string; bodyId: string; faceStableId: string
  } | null>(null)
  const [machiningBoundaryPickActive, setMachiningBoundaryPickActive] = useState(false)
  const [machiningBoundaryPickError, setMachiningBoundaryPickError] = useState<string | null>(null)
  // CAM-DRILL-ADAPTER: durable ModelReference for model-kernel Detect holes.
  // Populated when Detect holes succeeds on a modeled body; folded into
  // op.modelReferences on Save so CAM-1 badges + live compute re-derive work.
  const [modelDrillBinding, setModelDrillBinding] = useState<{
    modelItemId?: string; bodyId: string; stableIds: string[]
  } | null>(null)
  const [modelBoreBinding, setModelBoreBinding] = useState<{
    modelItemId?: string; bodyId: string; faceStableId: string
    derived?: { loop: Loop2D; cylinder: CylinderFeature }
  } | null>(null)
  // WO-208: a picked modeled-body edge chain is bound to the compound Model
  // Item/body identity it came from; raw body ids are not project-global.
  const [modelEdgeChain, setModelEdgeChain] = useState<
    { modelItemId?: string; bodyId: string; edgeStableIds: string[] } | null
  >(null)
  const [modelEdgePicks, setModelEdgePicks] = useState<string[]>([])
  const [modelEdgePickError, setModelEdgePickError] = useState<string | null>(null)
  const [modelEdgeMigratedIds, setModelEdgeMigratedIds] = useState<string[]>([])

  // Contour cutting strategy: ONE explicit selector replacing the entangled
  // enableRoughing + enableFinish checkboxes. Default = cut straight to the
  // geometry with a finish pass (no roughing). See ContourCuttingStrategy.
  const [contourMode, setContourMode] = useState<ContourCuttingStrategy>('cut_at_geometry')

  const operationModalSessionKey =
    activeModal === 'new-operation'
      ? `${project.id}:new-operation`
      : activeModal === 'edit-operation'
        ? `${project.id}:edit-operation:${editingOpPayload?.setupId ?? ''}:${editingOpPayload?.opId ?? ''}`
        : null
  const previousOperationModalSessionKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const previousSessionKey = previousOperationModalSessionKeyRef.current
    previousOperationModalSessionKeyRef.current = operationModalSessionKey
    if (previousSessionKey === null || previousSessionKey === operationModalSessionKey) return

    // A direct new/edit replacement does not unmount this hook. End only this
    // picker's local banner/state along with its viewport presentation so the
    // replacement modal cannot inherit a stale callback or collapsed UI.
    finishMachiningBoundaryPickPresentation()
    // Q-92: the replacement modal must also inherit ordinary whole-body
    // selection, not a suspension its own pick never armed.
    useCamStore.getState().endFacePickBodySelection(null, getVp())
    setMachiningBoundaryPickActive(false)
    setBrepPickKind(current => current === 'machining-boundary' ? null : current)
  }, [operationModalSessionKey])

  // The store subscription in the presentation helper catches modal, edit
  // payload, and project replacement. This React cleanup is the final owner
  // boundary for wrapper unmounts (including app-shell/test teardown) that do
  // not need to mutate the store first.
  useEffect(() => () => {
    finishMachiningBoundaryPickPresentation()
    useCamStore.getState().endFacePickBodySelection(null, getVp())
  }, [])

  // BK-178-DECOMP: ends an active per-hole "review in viewport" -- restores the
  // op's selection highlight and the pre-review camera. Depends only on state
  // setters + refs owned here, so it lives in the hook (the Escape-key effect
  // below references it) and is handed to the body via the returned state.
  const stopHoleReview = () => {
    setReviewingHoleLoopId(null)
    // Restore the op's current selection highlight (guarded for jsdom tests).
    getVp()?.setPickedLoops?.(savedReviewPickedLoopIds)
    // Restore the prior camera view too, then clear the saved pose.
    if (savedReviewCameraRef.current) {
      getVp()?.restoreCameraState?.(savedReviewCameraRef.current)
      savedReviewCameraRef.current = null
    }
  }

  // Pre-fill state when opening in edit mode
  useEffect(() => {
    // Clear any prior fail-loud error on every lifecycle transition (modal
    // open/close/edit-payload change) so a stale error never leaks across opens.
    setEditLoadError(null)
    setHeightRepairMessage(null)
    if (activeModal !== 'edit-operation' || !editingOpPayload) return
    const { setupId, opId } = editingOpPayload
    const state = useCamStore.getState()
    const editSetup = state.project.setups.find(s => s.id === setupId)
    const op = editSetup?.operations.find(o => o.id === opId)
    if (!op) return

    // Persisted empty loopIds historically meant "all". Preserve that meaning
    // when editing an existing operation; this does not affect new operations.
    setUserClearedLoops(false)

    setOpName(op.name)
    setToolId(op.toolId)
    setHeights(op.heights)
    setCustomEndCondition(false)
    setPasses(op.passes)
    setLinking(op.linking)
    setRestMachining(readRestMachiningSettings(op.params))

    // CAM-BINDING Stage 5: prefill the picked machining-boundary face from
    // the op being edited ("edit reuses the original creation UI w/ values
    // loaded"). Only ONE role/body is expected today (Stage 5 populates a
    // single machining-boundary reference); a stray extra entry is ignored
    // rather than erroring the whole edit-prefill.
    const boundaryRef = op.modelReferences?.find(r => r.role === 'machining-boundary')
    setMachiningBoundaryFace(
      boundaryRef && boundaryRef.stableIds.length > 0
        ? {
            modelItemId: boundaryRef.modelItemId,
            bodyId: boundaryRef.bodyId,
            faceStableId: boundaryRef.stableIds[0],
          }
        : null,
    )
    setMachiningBoundaryPickError(null)
    const boreRef = op.modelReferences?.find(r => r.role === 'bore-target')
    setModelBoreBinding(
      boreRef && boreRef.stableIds.length === 1
        ? {
            modelItemId: boreRef.modelItemId,
            bodyId: boreRef.bodyId,
            faceStableId: boreRef.stableIds[0],
          }
        : null,
    )
    const drillRef = op.modelReferences?.find(r => r.role === 'drill-targets')
    setModelDrillBinding(
      drillRef && drillRef.stableIds.length > 0
        ? {
            modelItemId: drillRef.modelItemId,
            bodyId: drillRef.bodyId,
            stableIds: [...drillRef.stableIds],
          }
        : null,
    )
    const edgeChainRef = op.modelReferences?.find(r => r.role === 'edge-chain')
    setModelEdgeChain(
      edgeChainRef && edgeChainRef.stableIds.length > 0
        ? {
            modelItemId: edgeChainRef.modelItemId,
            bodyId: edgeChainRef.bodyId,
            edgeStableIds: [...edgeChainRef.stableIds],
          }
        : null,
    )
    setModelEdgePicks([])
    setModelEdgePickError(null)
    setModelEdgeMigratedIds([])

    const opTool = useCamStore.getState().toolLibrary.find(t => t.id === op.toolId)
    setFeedrateOverride(op.feedrateOverride ?? { ...defaultFeedrateOverride(opTool, project.machine.rapidRate), enabled: false })

    if (op.type === 'pocket_2d') {
      setOpType('pocket_2d')
      const pp = payloadOf('pocket_2d', op.params)
      setPocket(pp)
      // Back-compat: older pocket ops stored the floor (axial) stock on the
      // per-op param. Migrate it into the shared passes field for display +
      // re-emit, unless the shared field is already populated.
      if (op.passes.floorStockToLeave === undefined && (pp.floorStockToLeave ?? 0) > 0)
        setPasses(p => ({ ...p, floorStockToLeave: pp.floorStockToLeave }))
    } else if (op.type === 'drill') {
      setOpType('drill')
      const dp = payloadOf('drill', op.params)
      setDrill({ ...defaultDrillParams, ...dp })
      setDrillBreakthroughSetByUser(true)
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority && !validatedAuthority.ok) {
        setHeightRepairMessage(validatedAuthority.message)
        setDrillBoreHeightDraft({ mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 })
        setDrillBoreHeightAuthority('new')
      } else if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          setDrillBoreHeightDraft(drillBoreSmartHeightDraftFromIntent(validatedAuthority.state.intent, 'drill'))
          setDrillBoreHeightAuthority('smart_v2')
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Drill authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setDrillBoreHeightDraft({ mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 })
          setDrillBoreHeightAuthority('new')
        }
      } else {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setDrillBoreHeightDraft({ mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 })
        setDrillBoreHeightAuthority('new')
      }
    } else if (op.type === 'bore') {
      setOpType('bore')
      const bp = payloadOf('bore', op.params)
      setBore({ ...defaultBoreParams, ...bp })
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority && !validatedAuthority.ok) {
        setHeightRepairMessage(validatedAuthority.message)
        setDrillBoreHeightDraft({ mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 })
        setDrillBoreHeightAuthority('new')
      } else if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          setDrillBoreHeightDraft(drillBoreSmartHeightDraftFromIntent(validatedAuthority.state.intent, 'bore'))
          setDrillBoreHeightAuthority('smart_v2')
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Bore authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setDrillBoreHeightDraft({ mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 })
          setDrillBoreHeightAuthority('new')
        }
      } else {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setDrillBoreHeightDraft({ mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 })
        setDrillBoreHeightAuthority('new')
      }
    } else if (op.type === 'thread_mill') {
      setOpType('thread_mill')
      const tp = payloadOf('thread_mill', op.params)
      setThreadMill({ ...defaultThreadMillParams, ...tp })
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority && !validatedAuthority.ok) {
        setHeightRepairMessage(validatedAuthority.message)
      } else if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2' &&
          validatedAuthority.state.intent.policy.operationType !== 'thread_mill') {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
      } else if (!validatedAuthority) {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
      }
    } else if (op.type === 'chamfer') {
      setOpType('chamfer')
      const cp = payloadOf('chamfer', op.params)
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority && !validatedAuthority.ok) {
        setHeightRepairMessage(validatedAuthority.message)
        setChamfer({ ...defaultChamferParams, ...cp })
      } else if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = chamferSmartHeightDraftFromIntent(validatedAuthority.state.intent)
          const datumReference = uiReferenceForIntentReference(draft.datumReference)
          if (!datumReference) {
            throw new Error(tx('useNewOperationModalState.Chamfer_datum_reference_is_not_editable_in_this_UI', { p1: draft.datumReference }))
          }
          setChamfer({
            ...defaultChamferParams,
            ...cp,
            heightReference: datumReference,
            planeOffset: draft.datumOffsetMm,
            chamferWidth: draft.chamferWidthMm,
            tipOffset: draft.tipOffsetMm,
          })
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Chamfer authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setChamfer(defaultChamferParams)
        }
      } else {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setChamfer(defaultChamferParams)
      }
    } else if (op.type === 'face') {
      setOpType('face')
      const fp = payloadOf('face', op.params)
      setFace({ ...defaultFaceParams, ...fp })
      // Back-compat: older face ops stored the floor (axial) stock on the per-op
      // param. Migrate it into the shared passes field unless already populated.
      if (op.passes.floorStockToLeave === undefined && (fp.floorStockToLeave ?? 0) > 0)
        setPasses(p => ({ ...p, floorStockToLeave: fp.floorStockToLeave }))
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority && !validatedAuthority.ok) {
        setHeightRepairMessage(validatedAuthority.message)
        setFaceHeightDraft({ mode: 'explicit_depth', explicitTargetWcsMm: -5 })
        setFaceHeightAuthority('new')
        setFaceHeightConfirmed(false)
      } else if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          setFaceHeightDraft(faceSmartHeightDraftFromIntent(validatedAuthority.state.intent))
          setFaceHeightAuthority('smart_v2')
          setFaceHeightConfirmed(true)
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Face authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setFaceHeightDraft({ mode: 'explicit_depth', explicitTargetWcsMm: -5 })
          setFaceHeightAuthority('new')
          setFaceHeightConfirmed(false)
        }
      } else {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setFaceHeightDraft({ mode: 'explicit_depth', explicitTargetWcsMm: -5 })
        setFaceHeightAuthority('new')
        setFaceHeightConfirmed(false)
      }
    } else if (op.type === 'engrave') {
      setOpType('engrave')
      const ep = payloadOf('engrave', op.params)
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority && !validatedAuthority.ok) {
        setHeightRepairMessage(validatedAuthority.message)
        setEngrave(defaultEngraveParams)
        setEngraveExplicitDepthMm(1)
        setEngraveDepthConfirmed(false)
      } else if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = engraveSmartHeightDraftFromIntent(validatedAuthority.state.intent)
          setEngrave({
            ...defaultEngraveParams,
            ...ep,
            heightReference: uiReferenceForIntentReference(draft.datumReference) ?? 'wcs_plane',
            planeOffset: draft.datumOffsetMm,
            axialOffset: draft.axialOffsetMm,
            useWidthForDepth: draft.depth.kind === 'line_width',
            ...(draft.depth.kind === 'line_width'
              ? { targetLineWidth: draft.depth.targetLineWidthMm }
              : {}),
          })
          setEngraveExplicitDepthMm(
            draft.depth.kind === 'explicit' ? draft.depth.depthMm : 1,
          )
          setEngraveDepthConfirmed(true)
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Engrave authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setEngrave(defaultEngraveParams)
          setEngraveExplicitDepthMm(1)
          setEngraveDepthConfirmed(false)
        }
      } else {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setEngrave(defaultEngraveParams)
        setEngraveExplicitDepthMm(1)
        setEngraveDepthConfirmed(false)
      }
    } else if (op.type === 'vcarve') {
      setOpType('vcarve')
      const vp = payloadOf('vcarve', op.params)
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      // The separate clearing tool lives on the sibling flat_clearing
      // operation of the same outlines; re-hydrate it so Save keeps the pair.
      const sameOutlines = (a: string[], b: string[]) =>
        a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')
      const sibling = editSetup?.operations.find(candidate => {
        if (candidate.id === op.id || candidate.type !== 'vcarve') return false
        const cp = payloadOf('vcarve', candidate.params)
        return cp.role === 'flat_clearing' && cp.geometryId === vp.geometryId && sameOutlines(cp.loopIds ?? [], vp.loopIds ?? [])
      })
      setVCarveClearingToolId(sibling?.toolId ?? '')
      if (validatedAuthority && !validatedAuthority.ok) {
        setHeightRepairMessage(validatedAuthority.message)
        setVCarve({ ...defaultVCarveParams, ...vp })
      } else if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = vcarveSmartHeightDraftFromIntent(validatedAuthority.state.intent)
          setVCarve({
            ...defaultVCarveParams,
            ...vp,
            heightReference: uiReferenceForIntentReference(draft.datumReference) ?? 'wcs_plane',
            planeOffset: draft.datumOffsetMm,
            startDepthMm: draft.startDepthMm,
            flatDepthMm: draft.flatDepth.kind === 'explicit' ? draft.flatDepth.depthMm : undefined,
          })
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore V-carve authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setVCarve({ ...defaultVCarveParams, ...vp })
        }
      } else {
        setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setVCarve({ ...defaultVCarveParams, ...vp })
      }
    } else if (op.type === 'adaptive_clearing_2d') {
      setOpType('adaptive_clearing_2d')
      const ap = payloadOf('adaptive_clearing_2d', op.params)
      setAdaptive({ ...defaultACParams, ...ap })
    } else if (op.type === 'parallel_3d') {
      setOpType('parallel_3d')
      const pp = { ...DEFAULT_PARALLEL3D_PARAMS, ...payloadOf('parallel_3d', op.params) }
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = parallel3dHeightDraftFromIntent(validatedAuthority.state.intent)
          setParallel3d({ ...pp, finishDepth: draft.finishDepthMm })
          setParallel3dHeightAuthority('smart_v2')
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Parallel 3D authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setParallel3d(DEFAULT_PARALLEL3D_PARAMS)
          setParallel3dHeightAuthority('new')
        }
      } else {
        setHeightRepairMessage(validatedAuthority && !validatedAuthority.ok
          ? validatedAuthority.message
          : SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setParallel3d(DEFAULT_PARALLEL3D_PARAMS)
        setParallel3dHeightAuthority('new')
      }
      setParallel3dPartId(op.geometrySelections[0] ?? '')
    } else if (op.type === 'waterline_3d') {
      setOpType('waterline_3d')
      const wp = { ...DEFAULT_WATERLINE_PARAMS, ...payloadOf('waterline_3d', op.params) }
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = waterline3dHeightDraftFromIntent(validatedAuthority.state.intent)
          setWaterline3d({ ...wp, finishDepth: draft.finishDepthMm })
          setWaterline3dHeightAuthority('smart_v2')
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Waterline 3D authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setWaterline3d(DEFAULT_WATERLINE_PARAMS)
          setWaterline3dHeightAuthority('new')
        }
      } else {
        setHeightRepairMessage(validatedAuthority && !validatedAuthority.ok
          ? validatedAuthority.message
          : SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setWaterline3d(DEFAULT_WATERLINE_PARAMS)
        setWaterline3dHeightAuthority('new')
      }
      setWaterline3dPartId(op.geometrySelections[0] ?? '')
    } else if (op.type === 'steep_shallow_3d') {
      setOpType('steep_shallow_3d')
      const sp = {
        ...DEFAULT_STEEP_SHALLOW3D_PARAMS,
        ...payloadOf('steep_shallow_3d', op.params),
      }
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = steepShallow3dHeightDraftFromIntent(validatedAuthority.state.intent)
          setSteepShallow3d({ ...sp, finishDepth: draft.finishDepthMm })
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Steep and Shallow 3D authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setSteepShallow3d(DEFAULT_STEEP_SHALLOW3D_PARAMS)
        }
      } else {
        setHeightRepairMessage(validatedAuthority && !validatedAuthority.ok
          ? validatedAuthority.message
          : SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setSteepShallow3d(DEFAULT_STEEP_SHALLOW3D_PARAMS)
      }
      setSteepShallow3dPartId(op.geometrySelections[0] ?? '')
    } else if (op.type === 'scallop_3d') {
      setOpType('scallop_3d')
      const params = { ...DEFAULT_SCALLOP3D_PARAMS, ...payloadOf('scallop_3d', op.params) }
      const validatedAuthority = op.smartHeight === undefined
        ? undefined : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = scallop3dHeightDraftFromIntent(validatedAuthority.state.intent)
          setScallop3d({ ...params, finishDepth: draft.finishDepthMm })
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Scallop 3D authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setScallop3d(DEFAULT_SCALLOP3D_PARAMS)
        }
      } else {
        setHeightRepairMessage(validatedAuthority && !validatedAuthority.ok
          ? validatedAuthority.message : SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setScallop3d(DEFAULT_SCALLOP3D_PARAMS)
      }
      setScallop3dPartId(op.geometrySelections[0] ?? '')
    } else if (op.type === 'pencil_3d') {
      setOpType('pencil_3d')
      const params = { ...DEFAULT_PENCIL3D_PARAMS, ...payloadOf('pencil_3d', op.params) }
      const validatedAuthority = op.smartHeight === undefined
        ? undefined : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        try {
          const draft = pencil3dHeightDraftFromIntent(validatedAuthority.state.intent)
          setPencil3d({ ...params, finishDepth: draft.finishDepthMm })
        } catch (error) {
          console.error('[Smart Height V2] Cannot restore Pencil 3D authoring state.', error)
          setHeightRepairMessage(SMART_HEIGHT_V2_REPAIR_MESSAGE)
          setPencil3d(DEFAULT_PENCIL3D_PARAMS)
        }
      } else {
        setHeightRepairMessage(validatedAuthority && !validatedAuthority.ok
          ? validatedAuthority.message : SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setPencil3d(DEFAULT_PENCIL3D_PARAMS)
      }
      setPencil3dPartId(op.geometrySelections[0] ?? '')
    } else if (op.type === 'adaptive_3d') {
      setOpType('adaptive_3d')
      setAdaptive3d({ ...DEFAULT_ADAPTIVE3D_PARAMS, ...payloadOf('adaptive_3d', op.params) })
      setAdaptive3dPartId(op.geometrySelections[0] ?? '')
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        setAdaptive3dHeightDraft(adaptive3dHeightDraftFromIntent(validatedAuthority.state.intent))
        setAdaptive3dHeightAuthority('smart_v2')
      } else {
        setHeightRepairMessage(validatedAuthority && !validatedAuthority.ok
          ? validatedAuthority.message
          : SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setAdaptive3dHeightDraft({
          mode: 'current_material',
          topWcsMm: 0,
          bottomWcsMm: -5,
        })
        setAdaptive3dHeightAuthority('new')
      }
    } else if (op.type === 'contour_2d') {
      setOpType('contour_2d')
      const cp = payloadOf('contour_2d', op.params)
      setContour({ ...defaultContourParams, ...cp })
      // Derive the strategy dropdown from the saved params so editing shows the
      // mode the op was created with (mirrors contourPassParamsForMode).
      setContourMode(deriveContourMode(op.passes, cp.contourFinishMode))
      const validatedAuthority = op.smartHeight === undefined
        ? undefined
        : validatePersistedSmartHeightState(op.smartHeight)
      if (validatedAuthority?.ok && validatedAuthority.state.kind === 'smart_v2') {
        setContourHeightDraft(contourSmartHeightDraftFromIntent(validatedAuthority.state.intent))
        setContourHeightAuthority('smart_v2')
      } else {
        setHeightRepairMessage(validatedAuthority && !validatedAuthority.ok
          ? validatedAuthority.message
          : SMART_HEIGHT_V2_REPAIR_MESSAGE)
        setContourHeightDraft({
          mode: 'explicit_depth',
          explicitTargetWcsMm: -5,
          throughAllowanceMm: 0.5,
        })
        setContourHeightAuthority('new')
      }
    } else if (op.type === 'pattern') {
      // WO-3001: the pattern editor is Phase C. Until then the dialog says so in
      // one sentence instead of rendering another family's controls.
      setEditLoadError(tx('useNewOperationModalState.pattern_has_no_editor_yet'))
    } else {
      // ADR-0003 (no silent fallbacks): OperationType members without an
      // edit-prefill branch
      // must NOT silently render Contour-shaped UI. Surface an explicit,
      // user-visible error instead. The typed assignment below is the
      // codebase's exhaustiveness tripwire (mirrors DesignTree's
      // `const _exhaustive: never = op.status`): adding a new OperationType
      // without its own branch above becomes a compile error until it is handled.
      const unhandled: never = op.type
      console.error(`[NewOperationModal] cannot edit operation type "${unhandled}": no edit UI (ADR-0003)`)
      setEditLoadError(tx('useNewOperationModalState.has_no_editor_in_this_dialog_Close_and_recreate', { p1: unhandled }))
    }
  }, [activeModal, editingOpPayload])

  // A fresh operation begins from its owning Setup's semantic defaults. Edit
  // mode continues to prefill the operation's own authored values above.
  useEffect(() => {
    if (activeModal !== 'new-operation') return
    setUserClearedLoops(true)
    const setup = useCamStore.getState().project.setups.find(
      (candidate) => candidate.id === useCamStore.getState().project.activeSetupId,
    )
    if (!setup) return
    const setupIntent = setupDefaultHeightIntent(setup)
    const projectFamily = <T extends object>(operationType: Parameters<typeof deriveOperationHeightDraft>[0]['operationType'], params: T) => {
      const draft = deriveOperationHeightDraft({
        operationType,
        setupIntent,
        currentParams: params as unknown as Record<string, unknown>,
      })
      return { heights: draft.heights, params: { ...params, ...draft.paramsPatch } as T }
    }
    const contourDraft = projectFamily('contour_2d', defaultContourParams)
    setHeights(contourDraft.heights)
    setAdaptive3dHeightDraft({
      mode: 'current_material',
      topWcsMm: contourDraft.heights.topHeight,
      bottomWcsMm: contourDraft.heights.bottomHeight,
    })
    setAdaptive3dHeightAuthority('new')
    setParallel3d(DEFAULT_PARALLEL3D_PARAMS)
    setParallel3dHeightAuthority('new')
    setWaterline3d(DEFAULT_WATERLINE_PARAMS)
    setWaterline3dHeightAuthority('new')
    setSteepShallow3d(DEFAULT_STEEP_SHALLOW3D_PARAMS)
    setPencil3d(DEFAULT_PENCIL3D_PARAMS)
    setRestMachining(DEFAULT_REST_MACHINING_SETTINGS)
    // WO-2694 (the operator 2026-10-09: "smart height should be model top, but user
    // over ridable"): a new Face over a setup whose stock holds a model ends at
    // the model top. Without a model (stock only, flat curves) it keeps the
    // setup's default Target End, as before.
    const project = useCamStore.getState().project
    const faceStockId = setupProvenStockId(setup, project)
    const faceModelTop = faceStockId ? smartHeightModelTop(project, faceStockId) : null
    setFaceHeightDraft(faceModelTop
      ? { mode: 'model_top', explicitTargetWcsMm: faceModelTop.modelTopMachineMm - setup.wcs.origin.z }
      : { mode: 'explicit_depth', explicitTargetWcsMm: contourDraft.heights.bottomHeight })
    setFaceHeightAuthority('new')
    setFaceHeightConfirmed(false)
    setContour(contourDraft.params)
    setContourHeightDraft({
      mode: 'selected_feature',
      explicitTargetWcsMm: contourDraft.heights.bottomHeight,
      throughAllowanceMm: 0.5,
    })
    setContourHeightAuthority('new')
    setDrillBoreHeightDraft({
      mode: 'detected_features',
      explicitStartWcsMm: contourDraft.heights.topHeight,
      explicitEndWcsMm: contourDraft.heights.bottomHeight,
    })
    setDrillBoreHeightAuthority('new')
    setPocket(projectFamily('pocket_2d', defaultPocketParams).params)
    setAdaptive(projectFamily('adaptive_clearing_2d', defaultACParams).params)
    setDrill(projectFamily('drill', defaultDrillParams).params)
    setDrillBreakthroughSetByUser(false)
    setBore(projectFamily('bore', defaultBoreParams).params)
    setFace(projectFamily('face', defaultFaceParams).params)
    setEngrave(projectFamily('engrave', defaultEngraveParams).params)
    setEngraveExplicitDepthMm(1)
    setEngraveDepthConfirmed(false)
    setVCarve(projectFamily('vcarve', defaultVCarveParams).params)
    setVCarveClearingToolId('')
    // Width/tip/thread/mesh-derived families deliberately retain their own
    // depth contracts; the pure projector returns no automatic patch for them.
    setChamfer(projectFamily('chamfer', defaultChamferParams).params)
    setThreadMill(projectFamily('thread_mill', defaultThreadMillParams).params)
    setModelDrillBinding(null)
    setModelBoreBinding(null)
  }, [activeModal, project.activeSetupId])

  // While a new operation still has untouched height authority, refine its
  // starting policy as real geometry/feature evidence arrives. Every explicit
  // height-policy edit promotes the corresponding authority to smart_v2, which
  // makes this effect leave that user's choice alone.
  useEffect(() => {
    if (activeModal !== 'new-operation') return
    const setup = project.setups.find(candidate => candidate.id === project.activeSetupId)
    if (!setup) return
    const setupStockId = setupProvenStockId(setup, project)
    const hasSetupStock = Boolean(setupStockId)
    // WO-2694: a new Face over a stock that holds a model ends at the model top.
    const faceHasModelTop = opType === 'face' && setupStockId !== undefined &&
      smartHeightModelTop(project, setupStockId) !== null
    const hasImplicitSingleSolid = project.geometry.filter(geometry =>
      geometry.type === 'mesh' || geometry.type === 'brep' || geometry.type === 'model',
    ).length === 1
    const drillBoreFeatureReady = (() => {
      if (opType !== 'drill' && opType !== 'bore') return false
      if (opType === 'drill' ? modelDrillBinding !== null : modelBoreBinding !== null) return true
      const params = opType === 'drill' ? drill : bore
      const sources = resolveOpGeometrySources(project.geometry, params.geometryId, opType)
      const loopIds = params.loopIds.length > 0
        ? params.loopIds
        : sources.flatMap(source => (source.loops ?? []).map(loop => loop.id))
      return loopIds.length > 0 && deriveDrillBoreFeatureBindings(sources, loopIds, opType).ok
    })()
    // WO-1610: a picked loop is a feature only when it carries a physical
    // floor (a model face, hole or boss). A flat sketch curve has none, so it
    // starts on the Contour's stock-based default instead of a selected-feature
    // authority that can never be built.
    const contourFeatureReady = opType === 'contour_2d' && contour.loopIds.length > 0 &&
      deriveContourFeatureBindings(
        // The same source scope NewOperationModalBody builds the authority from.
        contour.geometryId === '__all__'
          ? resolveOpGeometrySources(project.geometry, '__all__', 'contour_2d')
          : project.geometry.filter(candidate => candidate.id === contour.geometryId),
        contour.loopIds,
      ).ok
    const selectedGeometryByFamily: Partial<Record<LiveSmartHeightOperationType, boolean>> = {
      face: face.targetPlaneGeo != null,
      contour_2d: contour.geometryId !== '' || modelEdgeChain !== null,
      // WO-1924: a picked model edge chain is selected geometry for the whole
      // profile family, exactly as for Contour.
      pocket_2d: (pocket.geometryId !== '' && pocket.geometryId !== '__all__') || modelEdgeChain !== null,
      adaptive_clearing_2d: (adaptive.geometryId !== '' && adaptive.geometryId !== '__all__') ||
        modelEdgeChain !== null,
      drill: drill.geometryId !== '',
      bore: bore.geometryId !== '',
      thread_mill: threadMill.geometryId !== '',
      engrave: engrave.geometryId !== '',
      vcarve: vcarve.geometryId !== '',
      chamfer: chamfer.geometryId !== '',
      parallel_3d: parallel3dPartId !== '' || hasImplicitSingleSolid,
      waterline_3d: waterline3dPartId !== '' || hasImplicitSingleSolid,
      steep_shallow_3d: steepShallow3dPartId !== '' || hasImplicitSingleSolid,
      scallop_3d: scallop3dPartId !== '' || hasImplicitSingleSolid,
      pencil_3d: pencil3dPartId !== '' || hasImplicitSingleSolid,
      adaptive_3d: adaptive3dPartId !== '' || hasImplicitSingleSolid,
    }
    const selectedFeatureByFamily: Partial<Record<LiveSmartHeightOperationType, boolean>> = {
      face: face.targetPlaneGeo != null,
      // A picked model edge chain is selected GEOMETRY, not a detected feature:
      // the selected-feature variant resolves from params.loopIds, which a bound
      // chain deliberately empties, so it can never resolve for one.
      contour_2d: contourFeatureReady,
      drill: drillBoreFeatureReady,
      bore: drillBoreFeatureReady,
      thread_mill: threadMill.geometrySource === 'cylinder',
      chamfer: chamfer.loopIds.length > 0,
    }
    const selectedGeometry = selectedGeometryByFamily[opType] === true
    const selectedFeature = selectedFeatureByFamily[opType] === true
    const selection = selectStartingHeightPolicy(opType, {
      hasSetupStock,
      hasSelectedGeometry: selectedGeometry,
      hasSelectedFeature: selectedFeature,
      hasTargetSurface: selectedGeometry || project.geometry.some(geometry =>
        geometry.type === 'mesh' || geometry.type === 'brep' || geometry.type === 'model'),
      hasModelTop: faceHasModelTop,
      explicitEndConfirmed: opType === 'face'
        ? faceHeightConfirmed
        : opType === 'engrave'
          ? engraveDepthConfirmed
          : false,
      boundarySource: opType === 'pocket_2d'
        ? pocket.boundarySource
        : opType === 'adaptive_clearing_2d'
          ? adaptive.boundarySource
          : undefined,
      useWidthForDepth: engrave.useWidthForDepth,
      hasFlatDepth: vcarve.flatDepthMm !== undefined,
      finishDepthMm: opType === 'waterline_3d'
        ? waterline3d.finishDepth
        : opType === 'steep_shallow_3d'
          ? steepShallow3d.finishDepth
          : opType === 'scallop_3d'
            ? scallop3d.finishDepth
            : opType === 'pencil_3d'
              ? pencil3d.finishDepth
            : parallel3d.finishDepth,
      threadKind: threadMill.threadKind,
      externalThreadReference: threadMill.externalReference,
    })
    setStartingHeightPolicy(current =>
      current.operationType === selection.operationType &&
      current.variant === selection.variant &&
      current.ready === selection.ready &&
      current.basis === selection.basis
        ? current
        : selection,
    )

    if (opType === 'face' && faceHeightAuthority === 'new' && !faceHeightConfirmed) {
      setFaceHeightDraft(current => ({
        ...current,
        mode: selection.variant === 'target_face'
          ? 'target_face'
          : selection.basis === 'geometry' ? 'model_top' : 'explicit_depth',
      }))
    } else if (opType === 'contour_2d' && contourHeightAuthority === 'new') {
      setContourHeightDraft(current => ({
        ...current,
        mode: selection.variant === 'selected_feature'
          ? 'selected_feature'
          : selection.variant === 'stock_bottom'
            ? 'stock_bottom'
            : 'explicit_depth',
      }))
    } else if ((opType === 'drill' || opType === 'bore') && drillBoreHeightAuthority === 'new') {
      setDrillBoreHeightDraft(current => ({
        ...current,
        mode: selection.variant === 'detected_features'
          ? 'detected_features'
          : 'explicit_depth',
      }))
    } else if (opType === 'adaptive_3d' && adaptive3dHeightAuthority === 'new') {
      setAdaptive3dHeightDraft(current => ({
        ...current,
        mode: selection.variant === 'current_material' ? 'current_material' : current.mode,
      }))
    }
  }, [
    activeModal, adaptive.boundarySource, adaptive.geometryId, adaptive3dHeightAuthority,
    adaptive3dPartId, bore.geometryId, bore.loopIds, chamfer.geometryId, chamfer.loopIds,
    contour.geometryId, contour.loopIds, contourHeightAuthority, drill.geometryId, drill.loopIds,
    drillBoreHeightAuthority, engrave.geometryId, engrave.useWidthForDepth,
    engraveDepthConfirmed, vcarve.geometryId, vcarve.flatDepthMm,
    face.targetPlaneGeo, faceHeightAuthority, faceHeightConfirmed, modelBoreBinding,
    modelDrillBinding, modelEdgeChain, opType, parallel3d.finishDepth, parallel3dPartId,
    pocket.boundarySource, pocket.geometryId, project, threadMill.externalReference,
    threadMill.geometryId, threadMill.geometrySource, threadMill.threadKind,
    waterline3d.finishDepth, waterline3dPartId, steepShallow3d.finishDepth, steepShallow3dPartId,
    scallop3d.finishDepth, scallop3dPartId, pencil3d.finishDepth, pencil3dPartId,
  ])

  // Clean up loop/brep pick modes when modal closes
  useEffect(() => {
    if (activeModal !== 'new-operation' && activeModal !== 'edit-operation') {
      // OP-TOOL-FILTER: filter bar is per-modal-open, no persistence -- clear
      // it whenever the modal fully closes so the next open starts fresh.
      setToolFilterSearch('')
      setToolFilterUsedOnly(false)
      setToolFilterLibraryId('all')
      getVp()?.setPartPickMode?.(null)
      getVp()?.setLoopPickMode?.(null)
      getVp()?.setBrepPickMode?.(null)
      // Q-92: closing the wizard exits face-pick mode, so ordinary whole-body
      // selection comes back exactly as it was before the pick armed.
      useCamStore.getState().endFacePickBodySelection(null, getVp())
      setIsPickingSourcePart(false)
      setIsPickingLoops(false)
      setBrepPickKind(null)
      setBrepFacePicks([])
      setBrepFaceTypes({})
      setBrepEdgePicks([])
      setBrepDeriveError(null)
      setBrepFaceDepthHint(null)
      setModelDrillBinding(null)
      setModelBoreBinding(null)
      // Tear down a live section scrub too — but only if WE own it (an STL
      // slice mode started from the DesignTree must not be killed here).
      setIsScrubbingSectionZ(prev => {
        if (prev) getVp()?.exitSlicePlaneMode?.()
        return false
      })
      // Leaving the modal entirely also tears down any active hole review so
      // the highlight + review state never leaks across opens.
      setReviewingHoleLoopId(prev => {
        if (prev) {
          getVp()?.setPickedLoops?.(savedReviewPickedLoopIds)
          // Restore the camera the review moved, mirroring stopHoleReview.
          if (savedReviewCameraRef.current) {
            getVp()?.restoreCameraState?.(savedReviewCameraRef.current)
            savedReviewCameraRef.current = null
          }
        }
        return null
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal])

  // Escape returns from a per-hole "review in viewport" (mirrors SetupModal's
  // vertex-pick Esc handler) — clears the review and restores the highlight.
  useEffect(() => {
    if (!reviewingHoleLoopId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stopHoleReview() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewingHoleLoopId])

  // When tool selection changes and override is not enabled, refresh the default values
  // so the Feedrate tab always shows the current tool's values as a starting point.
  useEffect(() => {
    if (feedrateOverride.enabled) return
    const tool = toolLibrary.find(t => t.id === toolId)
    setFeedrateOverride(prev => ({ ...defaultFeedrateOverride(tool, project.machine.rapidRate), enabled: prev.enabled }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId])

  // Auto-set pocket stepover (35% of tool ⌀) whenever the operation type or tool
  // changes — skipped in edit mode so saved values are kept. Stock-to-leave is NOT
  // auto-seeded for pockets (no inherent roughing signal); it defaults to 0 and the
  // user dials it in via the standardized Stock to leave controls on the Passes tab.
  useEffect(() => {
    if (opType !== 'pocket_2d') return
    if (activeModal === 'edit-operation') return
    const tool = toolLibrary.find(t => t.id === toolId)
    if (!tool) return
    const stepover   = Math.round(tool.diameter * 0.35 * 10) / 10
    setPasses(p => ({ ...p, stepover }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, toolId])

  // Auto-set facing stepover (70% of tool ⌀) and pass extension (50% of tool ⌀)
  // when the type or tool changes — skipped in edit mode so saved values are kept.
  useEffect(() => {
    if (opType !== 'face') return
    if (activeModal === 'edit-operation') return
    const tool = toolLibrary.find(t => t.id === toolId)
    if (!tool) return
    const stepover = Math.round(tool.diameter * 0.7 * 10) / 10
    setPasses(p => ({ ...p, stepover }))
    setFace(f => ({ ...f, passExtension: Math.round(tool.diameter * 0.5 * 10) / 10 }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, toolId])

  // Auto-set adaptive-clearing optimal load (25% of tool diameter) whenever the
  // operation type or tool changes -- skipped in edit mode so saved values are kept.
  // The shared defaultPasses.stepover (3 mm) rendered as ~97% of a small tool's
  // diameter (near-slotting); 25% is a safe starting engagement for adaptive.
  useEffect(() => {
    if (opType !== 'adaptive_clearing_2d') return
    if (activeModal === 'edit-operation') return
    const tool = toolLibrary.find(t => t.id === toolId)
    if (!tool) return
    const stepover = Math.round(tool.diameter * 0.25 * 100) / 100
    setPasses(p => ({ ...p, stepover }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, toolId])

  // WO-2211: a new 3D operation with a stepover field (Parallel Finish, Steep and
  // Shallow, Adaptive Rough 3D) starts at the chosen tool's library stepover
  // when the tool record has one; a tool without one gets the op's flat default.
  // Scallop (cusp height), Waterline (stepdown) and Pencil carry no stepover.
  // Measured by WO-2206: the flat 1 mm on a 1.6 mm ball lifted every portrait
  // link; the ball's library 0.16 mm kept 629 of 633 down. Skipped in edit mode
  // so saved values are kept; re-runs on modal open because the open reset above
  // restores the flat defaults while toolId may be unchanged.
  useEffect(() => {
    if (activeModal !== 'new-operation') return
    if (opType !== 'parallel_3d' && opType !== 'steep_shallow_3d' && opType !== 'adaptive_3d') return
    const tool = toolLibrary.find(t => t.id === toolId)
    if (!tool) return
    const libraryMm = libraryStepoverMm(tool)
    if (opType === 'parallel_3d') {
      const stepover = libraryMm ?? DEFAULT_PARALLEL3D_PARAMS.stepover
      setParallel3d(p => ({ ...p, stepover }))
    } else if (opType === 'steep_shallow_3d') {
      const stepover = libraryMm ?? DEFAULT_STEEP_SHALLOW3D_PARAMS.stepover
      setSteepShallow3d(p => ({ ...p, stepover }))
    } else {
      // Adaptive 3D's stepover is a fraction of the tool diameter, clamped to (0, 1].
      const stepover = libraryMm !== undefined && tool.diameter > 0
        ? Math.min(1, Math.max(0.01, Math.round((libraryMm / tool.diameter) * 100) / 100))
        : DEFAULT_ADAPTIVE3D_PARAMS.stepover
      setAdaptive3d(p => ({ ...p, stepover }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, opType, toolId])

  // Adaptive clearing is inherently a ROUGHING op, so seed a REAL radial stock to
  // leave of 0.3 mm when switching to it (not a display fallback) — but only if the
  // value is currently 0/unset, so a user-entered value is never stomped. Axial
  // (floor) stock stays 0 by default. Skipped in edit mode so saved values persist.
  useEffect(() => {
    if (opType !== 'adaptive_clearing_2d') return
    if (activeModal === 'edit-operation') return
    setPasses(p => (p.stockToLeave > 0 ? p : { ...p, stockToLeave: 0.3 }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType])

  useEffect(() => {
    if (opType !== 'bore' || activeModal === 'edit-operation') return
    const tool = toolLibrary.find(t => t.id === toolId)
    const stepover = tool ? Math.round(tool.diameter * 0.35 * 100) / 100 : defaultPasses.stepover
    setPasses(p => ({
      ...p,
      stepover,
      stockToLeave: p.stockToLeave > 0 ? p.stockToLeave : 0.1,
      finishPasses: Math.max(1, p.finishPasses),
    }))
    setLinking(l => ({ ...l, entryType: 'ramp_helical' }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, toolId])

  // Auto-set tool-relative contour pass defaults (Operator's defaults) whenever the
  // type or tool changes -- skipped in edit mode so saved values are kept. With
  // R = tool radius: Stock-to-leave = R/8, Contour overlap = R, finish=1, spring=0.
  // Stepdown is left at the shared default. These seed the FIELDS; in
  // cut_at_geometry mode the EMITTED stockToLeave is still 0 (no roughing), and
  // the contourPassParamsForMode Math.max(0.01) clamp is only a floor -- R/8 for
  // any sane tool (>=0.08 mm ⌀) exceeds it, so the seed survives. Until a tool is
  // picked (toolId === '') this no-ops and the shared defaultPasses apply.
  useEffect(() => {
    if (opType !== 'contour_2d') return
    if (activeModal === 'edit-operation') return
    const tool = toolLibrary.find(t => t.id === toolId)
    if (!tool) return
    const r = tool.diameter / 2
    const stockToLeave = Math.round((r / 8) * 100) / 100
    const overlapMm = Math.round(r * 100) / 100
    setPasses(p => ({ ...p, stockToLeave, overlapMm, finishPasses: 1, springPasses: 0 }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, toolId])

  // Auto-set pocket entry type and stay-down based on fill strategy.
  // inside-out → helix entry, stay-down off.
  // outside-in → ramp entry, stay-down on (1 mm lift).
  // Skipped in edit mode so saved values are kept.
  useEffect(() => {
    if (opType !== 'pocket_2d') return
    if (activeModal === 'edit-operation') return
    if (pocket.fillStrategy === 'outside_in') {
      setLinking(l => ({
        ...l,
        entryType: normalizePocketEntryForFillStrategy('outside_in', l.entryType),
      }))
      setPocket(p => ({ ...p, stayDown: true, stayDownLift: p.stayDownLift ?? 1.0 }))
    } else {
      setLinking(l => ({
        ...l,
        entryType: normalizePocketEntryForFillStrategy('inside_out', l.entryType),
      }))
      setPocket(p => ({ ...p, stayDown: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, pocket.fillStrategy])

  const restMachiningSupported = opType === 'parallel_3d' || opType === 'steep_shallow_3d' ||
    opType === 'scallop_3d' || opType === 'pencil_3d'
  const restMachiningSetupId = activeModal === 'edit-operation'
    ? editingOpPayload?.setupId
    : project.activeSetupId
  const restMachiningSetup = project.setups.find(candidate => candidate.id === restMachiningSetupId)
  const restMachiningAvailabilityState = restMachiningAvailability(
    restMachiningSetup?.operations ?? [],
    activeModal === 'edit-operation' ? editingOpPayload?.opId : undefined,
  )
  useEffect(() => {
    if ((activeModal !== 'new-operation' && activeModal !== 'edit-operation') ||
        !restMachiningSupported || restMachiningAvailabilityState.available ||
        !restMachiningAvailabilityState.reason) return
    console.warn(`[Rest machining] ${restMachiningAvailabilityState.reason}`)
  }, [activeModal, restMachiningAvailabilityState.available, restMachiningAvailabilityState.reason, restMachiningSupported])

  return {
    activeModal, closeModal, project, toolLibrary, toolLibraries, addOperation, updateOperation, editingOpPayload,
    machineActionKind, setMachineActionKind,
    computeToolpath, previewAdaptive3dSmartHeights, previewParallel3dSmartHeights, previewWaterline3dSmartHeights, previewFaceSmartHeights, previewPlanarRoughSmartHeights, previewContourSmartHeights, previewDrillBoreSmartHeights, previewThreadMillSmartHeights, previewChamferSmartHeights, previewEngraveSmartHeights, deriveBrepLayer, displayUnits, savedReviewCameraRef, tab, setTab, opType,
    setOpType, opName, setOpName, toolId, setToolId, heights, setHeights, customEndCondition,
    setCustomEndCondition, passes, setPasses, linking, setLinking, contour, setContour,
    contourHeightDraft, setContourHeightDraft, contourHeightAuthority, setContourHeightAuthority, pocket,
    setPocket, drill, setDrill, bore, setBore, drillBoreHeightDraft, setDrillBoreHeightDraft,
    drillBoreHeightAuthority, setDrillBoreHeightAuthority, drillBreakthroughSetByUser, setDrillBreakthroughSetByUser, threadMill, setThreadMill, chamfer,
    setChamfer, face, setFace, engrave, setEngrave, engraveExplicitDepthMm, setEngraveExplicitDepthMm,
    engraveDepthConfirmed, setEngraveDepthConfirmed, vcarve, setVCarve, vcarveClearingToolId, setVCarveClearingToolId,
    adaptive, setAdaptive, parallel3d,
    setParallel3d, parallel3dPartId, setParallel3dPartId, parallel3dHeightAuthority, setParallel3dHeightAuthority,
    waterline3d, setWaterline3d, waterline3dPartId, setWaterline3dPartId, waterline3dHeightAuthority, setWaterline3dHeightAuthority,
    steepShallow3d, setSteepShallow3d, steepShallow3dPartId, setSteepShallow3dPartId,
    scallop3d, setScallop3d, scallop3dPartId, setScallop3dPartId,
    pencil3d, setPencil3d, pencil3dPartId, setPencil3dPartId,
    restMachining, setRestMachining, restMachiningAvailabilityState,
    adaptive3d, setAdaptive3d, adaptive3dPartId, setAdaptive3dPartId,
    adaptive3dHeightDraft, setAdaptive3dHeightDraft, adaptive3dHeightAuthority, setAdaptive3dHeightAuthority, isPickingSourcePart,
    faceHeightDraft, setFaceHeightDraft, faceHeightAuthority, setFaceHeightAuthority, faceHeightConfirmed, setFaceHeightConfirmed,
    setIsPickingSourcePart, isPickingLoops, setIsPickingLoops, toolFilterSearch, setToolFilterSearch, toolFilterUsedOnly, setToolFilterUsedOnly, toolFilterLibraryId,
    setToolFilterLibraryId, reviewingHoleLoopId, setReviewingHoleLoopId, savedReviewPickedLoopIds, setSavedReviewPickedLoopIds, userClearedLoops, setUserClearedLoops, brepPickKind,
    setBrepPickKind, brepFacePicks, setBrepFacePicks, brepFaceTypes, setBrepFaceTypes, brepEdgePicks, setBrepEdgePicks, brepDeriving,
    setBrepDeriving, brepDeriveError, setBrepDeriveError, editLoadError, setEditLoadError,
    heightRepairMessage, setHeightRepairMessage, startingHeightPolicy,
    brepFaceDepthHint, setBrepFaceDepthHint, brepSectionZStr,
    setBrepSectionZStr, isScrubbingSectionZ, setIsScrubbingSectionZ, feedrateOverride, setFeedrateOverride, machiningBoundaryFace, setMachiningBoundaryFace, machiningBoundaryPickActive,
    setMachiningBoundaryPickActive, machiningBoundaryPickError, setMachiningBoundaryPickError, modelDrillBinding, setModelDrillBinding, modelBoreBinding, setModelBoreBinding, contourMode, setContourMode,
    modelEdgeChain, setModelEdgeChain, modelEdgePicks, setModelEdgePicks, modelEdgePickError, setModelEdgePickError,
    modelEdgeMigratedIds, setModelEdgeMigratedIds,
    stopHoleReview,
  }
}
