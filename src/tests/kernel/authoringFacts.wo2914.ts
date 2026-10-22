import type { OperationAuthoringFacts } from '../../kernel/authoring'
import type { OperationType } from '../../types'

export function validFacts(type: OperationType): OperationAuthoringFacts {
  const resolved = { state: 'resolved' as const }
  return { type, contourPathType: 'closed', closedLoopCount: 1, selectedLoopCount: 1,
    loopSelectorVisible: true, userClearedLoops: false, sourceSelected: true, sourceIsModel: false,
    contourModelReferences: false, pocketEdgeChainModelReferences: false, adaptiveEdgeChainModelReferences: false,
    engraveModelReferences: false, vcarveModelReferences: false, chamferModelReferences: false,
    heightRepairRequired: false, faceHeightChosen: true, planarStockSmartActive: true, planarGeometrySmartActive: false,
    engraveUseWidthForDepth: true, engraveDepthEntered: true, vcarveClearingToolPresent: true,
    pencilCutterSupported: true, parallelCutterSupported: true, cutter3dSupported: true, adaptive3dBandValid: true,
    toolId: 'tool', parallelHeightPartIdEff: 'part', waterline3dPartIdEff: 'part', adaptive3dPartIdEff: 'part',
    threadMillHeightAuthority: 'smart_v2', chamferHeightAuthority: 'smart_v2', engraveHeightAuthority: 'smart_v2',
    vcarveHeightAuthority: 'smart_v2', vcarveClearingMode: 'none',
    faceHeightPreview: resolved, planarRoughHeightPreview: resolved, contourHeightPreview: resolved,
    drillBoreHeightPreview: resolved, threadMillHeightPreview: resolved, chamferHeightPreview: resolved,
    engraveHeightPreview: resolved, vcarveHeightPreview: resolved, parallel3dHeightPreview: resolved,
    waterline3dHeightPreview: resolved, adaptive3dHeightPreview: resolved }
}

