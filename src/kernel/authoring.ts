import type { OperationType } from '../types'

/** Resolved facts from the same geometry/height preflights used by the screen.
 * No planner, browser or controller is invoked by an authoring decision. */
export interface AuthoringHeightPreview {
  state: 'idle' | 'loading' | 'resolved' | 'error'
  message?: string
}
export type AuthoringText = (key: string, args?: Record<string, string | number>) => string
export interface OperationAuthoringFacts {
  type: OperationType
  contourPathType: 'open' | 'closed'
  closedLoopCount: number
  selectedLoopCount: number
  loopSelectorVisible: boolean
  userClearedLoops: boolean
  sourceSelected: boolean
  sourceIsModel: boolean
  contourModelReferences: boolean
  pocketEdgeChainModelReferences: boolean
  adaptiveEdgeChainModelReferences: boolean
  engraveModelReferences: boolean
  vcarveModelReferences: boolean
  chamferModelReferences: boolean
  heightRepairRequired: boolean
  faceHeightChosen: boolean
  planarStockSmartActive: boolean
  planarGeometrySmartActive: boolean
  engraveUseWidthForDepth: boolean
  engraveDepthEntered: boolean
  vcarveClearingToolPresent: boolean
  pencilCutterSupported: boolean
  parallelCutterSupported: boolean
  cutter3dSupported: boolean
  adaptive3dBandValid: boolean
  toolId: string
  parallelHeightPartIdEff: string
  waterline3dPartIdEff: string
  adaptive3dPartIdEff: string
  threadMillHeightAuthority: string
  chamferHeightAuthority: string
  engraveHeightAuthority: string
  vcarveHeightAuthority: string
  vcarveClearingMode: string
  faceHeightPreview: AuthoringHeightPreview
  planarRoughHeightPreview: AuthoringHeightPreview
  contourHeightPreview: AuthoringHeightPreview
  drillBoreHeightPreview: AuthoringHeightPreview
  threadMillHeightPreview: AuthoringHeightPreview
  chamferHeightPreview: AuthoringHeightPreview
  engraveHeightPreview: AuthoringHeightPreview
  vcarveHeightPreview: AuthoringHeightPreview
  parallel3dHeightPreview: AuthoringHeightPreview
  waterline3dHeightPreview: AuthoringHeightPreview
  adaptive3dHeightPreview: AuthoringHeightPreview
}

export function operationAuthoringDecision(facts: OperationAuthoringFacts, tx: AuthoringText) {
  const { type, contourPathType, closedLoopCount, selectedLoopCount, loopSelectorVisible, userClearedLoops, sourceSelected, sourceIsModel, contourModelReferences, pocketEdgeChainModelReferences, adaptiveEdgeChainModelReferences, engraveModelReferences, vcarveModelReferences, chamferModelReferences, heightRepairRequired, faceHeightChosen, planarStockSmartActive, planarGeometrySmartActive, engraveUseWidthForDepth, engraveDepthEntered, vcarveClearingToolPresent, pencilCutterSupported, parallelCutterSupported, cutter3dSupported, adaptive3dBandValid, toolId, parallelHeightPartIdEff, waterline3dPartIdEff, adaptive3dPartIdEff, threadMillHeightAuthority, chamferHeightAuthority, engraveHeightAuthority, vcarveHeightAuthority, vcarveClearingMode, faceHeightPreview, planarRoughHeightPreview, contourHeightPreview, drillBoreHeightPreview, threadMillHeightPreview, chamferHeightPreview, engraveHeightPreview, vcarveHeightPreview, parallel3dHeightPreview, waterline3dHeightPreview, adaptive3dHeightPreview } = facts
  const isContour = type === 'contour_2d'
  const isPocket = type === 'pocket_2d'
  const isAdaptive = type === 'adaptive_clearing_2d'
  const isEngrave = type === 'engrave'
  const isVCarve = type === 'vcarve'
  const isChamfer = type === 'chamfer'
  const isDrill = type === 'drill'
  const isBore = type === 'bore'
  const isThreadMill = type === 'thread_mill'
  const isFace = type === 'face'
  const isParallel3d = type === 'parallel_3d'
  const isSteepShallow3d = type === 'steep_shallow_3d'
  const isScallop3d = type === 'scallop_3d'
  const isPencil3d = type === 'pencil_3d'
  const isWaterline3d = type === 'waterline_3d'
  const isAdaptive3d = type === 'adaptive_3d'
  // BUG-463 / WO-1924: an effective model boundary supersedes cleared loops.
  const loopsExplicitlyEmpty = loopSelectorVisible && userClearedLoops && selectedLoopCount === 0 &&
    !(isContour && contourModelReferences) &&
    !(isPocket && pocketEdgeChainModelReferences) &&
    !(isAdaptive && adaptiveEdgeChainModelReferences) &&
    !(isEngrave && engraveModelReferences) &&
    !(isVCarve && vcarveModelReferences) &&
    !(isChamfer && chamferModelReferences)
  const contourHasNoEligiblePaths =
    isContour &&
    sourceSelected &&
    !(sourceIsModel && contourPathType === 'closed') &&
    closedLoopCount === 0
  const faceHeightValid = !heightRepairRequired &&
    faceHeightChosen && faceHeightPreview.state === 'resolved'
  const planarRoughHeightValid = (!isPocket && !isAdaptive) || (
    (planarStockSmartActive || planarGeometrySmartActive) &&
    planarRoughHeightPreview.state === 'resolved'
  )
  const contourHeightValid = !heightRepairRequired &&
    contourHeightPreview.state === 'resolved'
  const drillBoreHeightValid = (!isDrill && !isBore) ||
    (!heightRepairRequired && drillBoreHeightPreview.state === 'resolved')
  const threadMillHeightValid = !isThreadMill ||
    (threadMillHeightAuthority !== 'repair_required' && threadMillHeightPreview.state === 'resolved')
  const chamferHeightValid = !isChamfer ||
    (chamferHeightAuthority !== 'repair_required' && chamferHeightPreview.state === 'resolved')
  const engraveHeightValid = !isEngrave || (engraveHeightAuthority !== 'repair_required' &&
    (engraveUseWidthForDepth || engraveDepthEntered) && engraveHeightPreview.state === 'resolved'
  )
  const vcarveClearingToolValid = !isVCarve || vcarveClearingMode !== 'tool' || vcarveClearingToolPresent
  const vcarveHeightValid = !isVCarve || (vcarveHeightAuthority !== 'repair_required' &&
    vcarveHeightPreview.state === 'resolved' && vcarveClearingToolValid
  )
  const canCreate = isParallel3d || isSteepShallow3d || isScallop3d || isPencil3d
    ? (!!toolId && (isPencil3d ? pencilCutterSupported : isParallel3d ? parallelCutterSupported : cutter3dSupported) && !!parallelHeightPartIdEff &&
       !heightRepairRequired && parallel3dHeightPreview.state === 'resolved')
    : isWaterline3d
    ? (!!toolId && cutter3dSupported && !!waterline3dPartIdEff &&
       !heightRepairRequired && waterline3dHeightPreview.state === 'resolved')
    : isAdaptive3d
    ? (!!toolId && cutter3dSupported && !!adaptive3dPartIdEff && adaptive3dBandValid &&
       !heightRepairRequired && adaptive3dHeightPreview.state === 'resolved')
    : isFace
    ? (!!toolId && !loopsExplicitlyEmpty && faceHeightValid)
    : (!!toolId && !loopsExplicitlyEmpty && !contourHasNoEligiblePaths &&
       planarRoughHeightValid && (!isContour || contourHeightValid) && drillBoreHeightValid &&
       threadMillHeightValid && chamferHeightValid && engraveHeightValid && vcarveHeightValid)
  const message =
              loopsExplicitlyEmpty ? tx('NewOperationModalBody.No_loops_are_selected_to_machine_Pick_at_least')
              : contourHasNoEligiblePaths ? tx('NewOperationModalBody.The_selected_source_has_no_to_machine', { p1: contourPathType === 'open' ? tx('NewOperationModalBody.open_paths') : tx('NewOperationModalBody.closed_profiles') })
              : !toolId ? tx('NewOperationModalBody.Go_to_the_Tool_tab_and_select_a_tool')
              : isFace && !faceHeightValid
                ? heightRepairRequired || !faceHeightChosen || faceHeightPreview.state === 'error'
                  ? tx('NewOperationModalBody.Choose_a_finished_face_in_Heights_Bottom_Height_Finished', { p1: faceHeightPreview.state === 'error' ? ` ${faceHeightPreview.message}` : '' })
                  : tx('NewOperationModalBody.Wait_for_Face_Smart_Height_preflight_to_resolve')
              : (isParallel3d || isSteepShallow3d || isScallop3d || isPencil3d) && !parallelHeightPartIdEff ? tx('NewOperationModalBody.Go_to_the_Geometry_tab_and_select_a_3D')
              : isPencil3d && !pencilCutterSupported ? tx('NewOperationModalBody.Pencil_needs_a_ball_or_bull_nose_end_mill')
              : isParallel3d && !parallelCutterSupported ? tx('NewOperationModalBody.Parallel_finish_needs_a_flat_ball_or_bull_nose')
              : (isSteepShallow3d || isScallop3d) && !cutter3dSupported ? tx('NewOperationModalBody.3D_finish_needs_a_flat_ball_or_bull_nose')
              : isAdaptive3d && !adaptive3dPartIdEff ? tx('NewOperationModalBody.Go_to_the_Geometry_tab_and_select_a_3D_2')
              : isAdaptive3d && !cutter3dSupported ? tx('NewOperationModalBody.3D_rough_needs_a_flat_ball_or_bull_nose')
              : isContour && contourHeightPreview.state === 'error' ? contourHeightPreview.message
              : isContour && !heightRepairRequired && contourHeightPreview.state !== 'resolved'
                ? tx('NewOperationModalBody.Wait_for_Contour_Smart_Height_preflight_to_resolve')
              : (isDrill || isBore) && drillBoreHeightPreview.state === 'error'
                ? drillBoreHeightPreview.message
              : (isDrill || isBore) && !heightRepairRequired && drillBoreHeightPreview.state !== 'resolved'
                ? tx('NewOperationModalBody.Wait_for_Smart_Height_preflight_to_resolve', { p1: isDrill ? tx('NewOperationModalBody.Drill') : tx('NewOperationModalBody.Bore') })
              : isThreadMill && threadMillHeightPreview.state === 'error'
                ? threadMillHeightPreview.message
              : isThreadMill && threadMillHeightAuthority !== 'repair_required' && threadMillHeightPreview.state !== 'resolved'
                ? tx('NewOperationModalBody.Wait_for_Thread_Mill_Smart_Height_preflight_to_resolve')
              : isEngrave && engraveHeightPreview.state === 'error'
                ? engraveHeightPreview.message
              : isEngrave && engraveHeightAuthority !== 'repair_required' &&
                  !engraveUseWidthForDepth && !engraveDepthEntered
                ? tx('NewOperationModalBody.Enter_the_explicit_Engrave_depth_on_the_Heights_tab')
              : isEngrave && engraveHeightAuthority !== 'repair_required' && engraveHeightPreview.state !== 'resolved'
                ? tx('NewOperationModalBody.Wait_for_Engrave_Smart_Height_preflight_to_resolve')
              : isVCarve && !vcarveClearingToolValid
                ? tx('NewOperationModalBody.Choose_the_end_mill_that_clears_the_flat_floors')
              : isVCarve && vcarveHeightPreview.state === 'error'
                ? vcarveHeightPreview.message
              : isVCarve && vcarveHeightAuthority !== 'repair_required' && vcarveHeightPreview.state !== 'resolved'
                ? tx('NewOperationModalBody.Wait_for_V_carve_Smart_Height_preflight_to_resolve')
              : undefined
  return { loopsExplicitlyEmpty, contourHasNoEligiblePaths, faceHeightValid, planarRoughHeightValid, contourHeightValid, drillBoreHeightValid, threadMillHeightValid, chamferHeightValid, engraveHeightValid, vcarveClearingToolValid, vcarveHeightValid, canCreate, message }
}

export interface SetupAuthoringFacts {
  heightsResolved: boolean
  fixtureStackError: string | null
  mustPickStock: boolean
  originMode: 'corner' | 'bore' | 'snap' | 'manual' | 'gizmo'
  boreBound: boolean
  secondSide: 'none' | 'resolved' | 'refused'
}

/** WO-294: never persist an unpicked bore. WO-288: a second side must
 * remain corner-bound to the same stock. These are the screen's save gates. */
export function setupAuthoringDecision(facts: SetupAuthoringFacts): boolean {
  return facts.heightsResolved && facts.fixtureStackError == null
    && !(facts.mustPickStock && (facts.originMode === 'corner' || facts.originMode === 'bore'))
    && !(facts.originMode === 'bore' && !facts.boreBound)
    && facts.secondSide !== 'refused'
    && !(facts.secondSide === 'resolved' && facts.originMode !== 'corner')
}
