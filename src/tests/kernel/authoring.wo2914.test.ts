import { validFacts } from './authoringFacts.wo2914'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { OPERATION_REGISTRY } from '../../kernel/registry'
import { operationAuthoringDecision, setupAuthoringDecision } from '../../kernel/authoring'
import type { OperationAuthoringFacts, AuthoringText, SetupAuthoringFacts } from '../../kernel/authoring'
import type { OperationType } from '../../types'

const text: AuthoringText = (key, args) => key + (args ? JSON.stringify(args) : '')
const oracle = runInNewContext(JSON.parse(readFileSync('src/tests/evidence/WO-2914/dialog-oracle.json', 'utf8')).oracle) as
  (facts: OperationAuthoringFacts, text: AuthoringText) => { canCreate: boolean; message?: string }

const operationTypes = Object.keys(OPERATION_REGISTRY) as OperationType[]

function casesFor(type: OperationType): OperationAuthoringFacts[] {
  const valid = validFacts(type)
  const cases: OperationAuthoringFacts[] = [valid]
  for (const [key, value] of Object.entries(valid)) {
    if (typeof value === 'boolean') cases.push({ ...valid, [key]: !value })
    if (typeof value === 'string' && key !== 'type' && key !== 'contourPathType') cases.push({ ...valid, [key]: '' }, { ...valid, [key]: 'repair_required' })
    if (key.endsWith('Preview')) for (const state of ['idle', 'loading', 'error'] as const) cases.push({ ...valid, [key]: { state, message: 'actual preflight explanation' } })
  }
  cases.push({ ...valid, userClearedLoops: true, selectedLoopCount: 0 },
    { ...valid, userClearedLoops: true, selectedLoopCount: 0, contourModelReferences: true, pocketEdgeChainModelReferences: true,
      adaptiveEdgeChainModelReferences: true, engraveModelReferences: true, vcarveModelReferences: true, chamferModelReferences: true },
    { ...valid, closedLoopCount: 0, contourPathType: 'open' }, { ...valid, closedLoopCount: 0, sourceIsModel: true },
    { ...valid, engraveUseWidthForDepth: false, engraveDepthEntered: false },
    { ...valid, vcarveClearingMode: 'tool', vcarveClearingToolPresent: false })
  return cases
}

type ApprovedReason = { label: string; message: string | undefined }

/**
 * The WO-2914 snapshot remains the boolean oracle.  WO-3137 intentionally
 * supersedes only its stale operator wording: a real unresolved preview is
 * not a running job, a running current preview is, and a repair/error names
 * its actual prerequisite.  This is deliberately a small fact policy rather
 * than a second copy of operationAuthoringDecision.
 */
function approvedReason(facts: OperationAuthoringFacts, legacy: { canCreate: boolean; message?: string }): ApprovedReason {
  if (legacy.canCreate || legacy.message && !legacy.message.startsWith('NewOperationModalBody.Wait_for_')) {
    return { label: 'unchanged-pinned-message', message: legacy.message }
  }
  const isThreadMill = facts.type === 'thread_mill'
  const isChamfer = facts.type === 'chamfer'
  const isEngrave = facts.type === 'engrave'
  const isVCarve = facts.type === 'vcarve'
  const isParallelFinish = ['parallel_3d', 'steep_shallow_3d', 'scallop_3d', 'pencil_3d'].includes(facts.type)
  if (!legacy.message && isParallelFinish && !facts.parallelHeightPartIdEff) return { label: 'missing-3d-geometry', message: text('NewOperationModalBody.Go_to_the_Geometry_tab_and_select_a_3D') }
  if (!legacy.message && facts.type === 'waterline_3d' && !facts.waterline3dPartIdEff) return { label: 'missing-3d-geometry', message: text('NewOperationModalBody.Go_to_the_Geometry_tab_and_select_a_3D') }
  if (!legacy.message && facts.type === 'adaptive_3d' && !facts.adaptive3dPartIdEff) return { label: 'missing-3d-geometry', message: text('NewOperationModalBody.Go_to_the_Geometry_tab_and_select_a_3D_2') }
  if (!legacy.message && facts.type === 'pencil_3d' && !facts.pencilCutterSupported) return { label: 'unsupported-3d-cutter', message: text('NewOperationModalBody.Pencil_needs_a_ball_or_bull_nose_end_mill') }
  if (!legacy.message && facts.type === 'parallel_3d' && !facts.parallelCutterSupported) return { label: 'unsupported-3d-cutter', message: text('NewOperationModalBody.Parallel_finish_needs_a_flat_ball_or_bull_nose') }
  if (!legacy.message && ['steep_shallow_3d', 'scallop_3d', 'waterline_3d'].includes(facts.type) && !facts.cutter3dSupported) return { label: 'unsupported-3d-cutter', message: text('NewOperationModalBody.3D_finish_needs_a_flat_ball_or_bull_nose') }
  if (!legacy.message && facts.type === 'adaptive_3d' && !facts.cutter3dSupported) return { label: 'unsupported-3d-cutter', message: text('NewOperationModalBody.3D_rough_needs_a_flat_ball_or_bull_nose') }
  if (!legacy.message && facts.type === 'adaptive_3d' && !facts.adaptive3dBandValid) return { label: 'invalid-adaptive-band', message: text('NewOperationModalBody.Band_top_must_be_greater_than_or_equal_to') }
  const repairRequired = isThreadMill ? facts.threadMillHeightAuthority === 'repair_required'
    : isChamfer ? facts.chamferHeightAuthority === 'repair_required'
    : isEngrave ? facts.engraveHeightAuthority === 'repair_required'
    : isVCarve ? facts.vcarveHeightAuthority === 'repair_required' : facts.heightRepairRequired
  if (!legacy.message && repairRequired) return { label: 'repair-required', message: text('NewOperationModalBody.Review_height_authority') }
  const preview = ['parallel_3d', 'steep_shallow_3d', 'scallop_3d', 'pencil_3d'].includes(facts.type)
    ? facts.parallel3dHeightPreview : facts.type === 'waterline_3d' ? facts.waterline3dHeightPreview
    : facts.type === 'adaptive_3d' ? facts.adaptive3dHeightPreview : facts.type === 'face' ? facts.faceHeightPreview
    : facts.type === 'contour_2d' ? facts.contourHeightPreview : (facts.type === 'drill' || facts.type === 'bore') ? facts.drillBoreHeightPreview
    : (facts.type === 'pocket_2d' || facts.type === 'adaptive_clearing_2d') ? facts.planarRoughHeightPreview
    : isThreadMill ? facts.threadMillHeightPreview : isChamfer ? facts.chamferHeightPreview
    : isEngrave ? facts.engraveHeightPreview : facts.vcarveHeightPreview
  if (!legacy.message && preview.state === 'error') return { label: 'actual-preflight-error', message: preview.message || text('NewOperationModalBody.Height_preflight_not_resolved') }
  if (!legacy.message || legacy.message.startsWith('NewOperationModalBody.Wait_for_')) {
    return preview.state === 'loading'
      ? { label: 'current-job-running', message: text('NewOperationModalBody.Height_preflight_running') }
      : { label: 'unresolved-not-running', message: text('NewOperationModalBody.Height_preflight_not_resolved') }
  }
  return { label: 'unchanged-pinned-message', message: legacy.message }
}

describe('WO-2914 authoring parity against pinned production dialog statements', () => {
  it.each(operationTypes)('%s keeps every readiness decision and its approved operator reason', type => {
    const valid = validFacts(type)
    for (const facts of casesFor(type)) {
      const actual = operationAuthoringDecision(facts, text)
      const legacy = oracle(facts, text)
      expect(actual.canCreate, `${type} readiness ${JSON.stringify(facts)}`).toBe(legacy.canCreate)
      expect(actual.message, `${type} ${approvedReason(facts, legacy).label} ${JSON.stringify(facts)}`).toBe(approvedReason(facts, legacy).message)
    }
    expect(operationAuthoringDecision(valid, text).canCreate).toBe(true)
  })
  it('accounts for all 1,343 pinned cases: 59 approved reason corrections and 1,284 untouched messages', () => {
    const counts = { total: 0, changed: 0, unchanged: 0 }
    const labels = new Set<string>()
    for (const type of operationTypes) for (const facts of casesFor(type)) {
      const legacy = oracle(facts, text)
      const approved = approvedReason(facts, legacy)
      counts.total++
      const actual = operationAuthoringDecision(facts, text)
      if (actual.message === legacy.message) counts.unchanged++
      else { counts.changed++; labels.add(approved.label) }
    }
    expect(counts).toEqual({ total: 1343, changed: 59, unchanged: 1284 })
    expect([...labels].sort()).toEqual(['actual-preflight-error', 'current-job-running', 'invalid-adaptive-band', 'missing-3d-geometry', 'repair-required', 'unresolved-not-running', 'unsupported-3d-cutter'])
  })
  it('keeps bore, second-side, fixture, stock and height setup save gates', () => {
    const base: SetupAuthoringFacts = { heightsResolved: true, fixtureStackError: null,
      mustPickStock: false, originMode: 'corner', boreBound: false, secondSide: 'none' }
    expect(setupAuthoringDecision(base)).toBe(true)
    for (const patch of [{ heightsResolved: false }, { fixtureStackError: 'actual fixture error' },
      { mustPickStock: true }, { originMode: 'bore' as const }, { secondSide: 'refused' as const },
      { secondSide: 'resolved' as const, originMode: 'manual' as const }]) expect(setupAuthoringDecision({ ...base, ...patch })).toBe(false)
    expect(setupAuthoringDecision({ ...base, originMode: 'bore', boreBound: true })).toBe(true)
    expect(setupAuthoringDecision({ ...base, originMode: 'gizmo' })).toBe(true)
  })
})
