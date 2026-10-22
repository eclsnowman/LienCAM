// WO-3020 (alpha.3 A3-11, parity): the ONE plan-to-builder conversion for both
// lanes. Today every family converts the resolved plan itself: the 2.5D lane
// into worker HeightParams in WCS (face.ts:477-503, threadMill.ts:626-655 and
// siblings), the 3D lane into part-local planes (adaptive3d.ts:186-226,
// parallel3d.ts:303-336, waterline3d.ts, steepShallow3d.ts, scallop3d.ts,
// pencil3d.ts - six near copies, DUP-013). Each conversion is copied here once,
// keeping the two differences that change numbers: the 2.5D snapshot reads the
// plan's wcsMm, the 3D snapshot reads machineMm minus the WCS origin; Adaptive
// 3D's stock top is its Material Start, the finishes' is the stock record's.
//
// `top_source` (MD-55, CARD) stays `stock_box_top`: the 3D rough's first level
// derives from the stock box top (adaptive3dOperation.ts:316, RC-009), not the
// resolved Top.

import type { HeightIntentV1, HeightParams } from '../../types'
import type {
  HeightEvidenceContext,
  OperationHeightIntentV2,
  ResolvedHeightPlanV2,
  ResolvedSmartHeightComponent,
} from './contracts'
import type { HeightsPolicy } from './policy'

/** Part-local planes a 3D strategy reads (structurally today's ResolvedParallel3dHeights). */
export interface LocalHeights {
  clearanceZ: number
  retractZ: number
  feedZ: number
  topZ: number
  bottomZ: number
  stockTopZ?: number
}

export type LocalStockTop =
  /** Adaptive 3D: the stock top is the resolved Material Start. */
  | { kind: 'material_start' }
  /** 3D finishes: the stock record's top, when the store proved one. */
  | { kind: 'stock_record'; machineMm?: number }

export class HeightsConversionError extends Error {
  readonly code = 'invalid_evidence' as const
  constructor(message: string) {
    super(message)
    this.name = 'HeightsConversionError'
  }
}

function cutterEnd(plan: ResolvedHeightPlanV2): ResolvedSmartHeightComponent {
  return plan.machining.cutterCenterEnd
    ?? (() => { throw new HeightsConversionError('Smart Height resolved no cutter-center Target End.') })()
}

const inferred = (offset: number) => ({ reference: 'wcs_plane' as const, offset, provenance: 'inferred' as const })

/** 2.5D lane: absolute WCS planes for the worker, plus their scalar snapshot. */
export function planToWorkerHeights(plan: ResolvedHeightPlanV2): {
  workerHeights: HeightParams
  snapshotIntent: HeightIntentV1
} {
  const end = cutterEnd(plan)
  const snapshotIntent: HeightIntentV1 = {
    version: 1,
    clearance: inferred(plan.safety.clearance.wcsMm),
    retract: inferred(plan.safety.retract.wcsMm),
    feed: inferred(plan.safety.feed.wcsMm),
    top: inferred(plan.machining.materialStart.wcsMm),
    bottom: inferred(end.wcsMm),
  }
  return {
    snapshotIntent,
    workerHeights: {
      clearanceHeight: plan.safety.clearance.wcsMm,
      clearanceHeightMode: 'absolute',
      retractHeight: plan.safety.retract.wcsMm,
      feedHeight: plan.safety.feed.wcsMm,
      topHeight: plan.machining.materialStart.wcsMm,
      topHeightMode: 'absolute',
      bottomHeight: end.wcsMm,
      bottomHeightMode: 'absolute',
      heightIntent: snapshotIntent,
    },
  }
}

/** 3D lane: planes in the part's local frame, the snapshot, and the finish depth
 *  (Top - Bottom, never negative) when the intent carries one. */
export function planToLocalHeights(plan: ResolvedHeightPlanV2, frame: {
  geometryPositionZ: number
  wcsOriginMachineMm: number
  stockTop: LocalStockTop
  withFinishDepth?: boolean
}): { localHeights: LocalHeights; snapshotIntent: HeightIntentV1; finishDepthMm?: number } {
  const end = cutterEnd(plan)
  const local = (machineMm: number) => machineMm - frame.geometryPositionZ
  const wcs = (machineMm: number) => machineMm - frame.wcsOriginMachineMm
  const topMachine = plan.machining.materialStart.machineMm
  const stockTopMachine = frame.stockTop.kind === 'material_start' ? topMachine : frame.stockTop.machineMm
  return {
    localHeights: {
      clearanceZ: local(plan.safety.clearance.machineMm),
      retractZ: local(plan.safety.retract.machineMm),
      feedZ: local(plan.safety.feed.machineMm),
      topZ: local(topMachine),
      bottomZ: local(end.machineMm),
      ...(stockTopMachine === undefined ? {} : { stockTopZ: local(stockTopMachine) }),
    },
    snapshotIntent: {
      version: 1,
      clearance: inferred(wcs(plan.safety.clearance.machineMm)),
      retract: inferred(wcs(plan.safety.retract.machineMm)),
      feed: inferred(wcs(plan.safety.feed.machineMm)),
      top: inferred(wcs(topMachine)),
      bottom: inferred(wcs(end.machineMm)),
    },
    ...(frame.withFinishDepth ? { finishDepthMm: Math.max(0, topMachine - end.machineMm) } : {}),
  }
}

/** The entities (or, for Thread Mill today, the evidence node ids) a resolved plan depends on, first-seen order. */
export function planDependencyIds(plan: ResolvedHeightPlanV2, key: 'entity' | 'node' = 'entity'): string[] {
  if (key === 'node') return plan.evidenceGraph.map(node => node.id)
  return plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) => ids.indexOf(id) === index)
}

/** Where a 3D rough's level ladder starts. Parity (`stock_box_top`): the stock box top. */
export function roughLevelTopZ(
  policy: Pick<HeightsPolicy, 'top_source'>,
  planes: { stockBoxTopZ: number },
): number {
  switch (policy.top_source) {
    case 'stock_box_top': return planes.stockBoxTopZ
  }
}

/** WO-1616 (copied from parallel3d.ts:155-170): a 3D surface finish may run with
 *  no assigned stock. The Setup's untouched "Stock top" safety default then binds
 *  to the target-model Top; a proven stock keeps it, a user-chosen one is never
 *  rebound. The five finish families apply it before resolving; Adaptive 3D does not. */
export function bindUnprovenStockTop(
  intent: OperationHeightIntentV2,
  evidence: HeightEvidenceContext,
): OperationHeightIntentV2 {
  if (evidence.evidence.some(node => node.kind === 'owning_stock' && node.role === 'stock_top')) return intent
  const bind = (plane: OperationHeightIntentV2['safety']['clearance']) =>
    plane.reference === 'stock_top' && plane.owner.kind === 'setup' ? { ...plane, reference: 'top' as const } : plane
  return {
    ...intent,
    safety: {
      clearance: bind(intent.safety.clearance),
      retract: bind(intent.safety.retract),
      feed: bind(intent.safety.feed),
    },
  }
}
