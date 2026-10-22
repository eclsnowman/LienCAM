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

describe('WO-2914 authoring parity against pinned production dialog statements', () => {
  it.each(Object.keys(OPERATION_REGISTRY) as OperationType[])('%s keeps every readiness and operator-message decision', type => {
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
    for (const facts of cases) {
      const actual = operationAuthoringDecision(facts, text)
      expect({ canCreate: actual.canCreate, message: actual.message }, JSON.stringify(facts)).toEqual(oracle(facts, text))
    }
    expect(operationAuthoringDecision(valid, text).canCreate).toBe(true)
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
