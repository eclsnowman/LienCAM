// WO-3307 (UI M2 W2-2b): Steep and shallow finish (steep_shallow_3d). Every field the old editors
// show, declared once, with the wider of their limits (the dialog caps the stepdown and stepover at
// the tool diameter and the shallow angle at 180 degrees, the Properties panel does not).
import { DEFAULT_STEEP_SHALLOW3D_PARAMS } from '../../../../kernel/parameterDefaults'
import { buildSteepShallow3dSmartIntent } from '../../../cam/smartHeights'
import { defineOpSchema, type OpContext, type ParamDecl, type ParamValues } from '../..'
import { blankAsUndefined, FACE_SCOPE, field, finiteNumber, finishDepthWrites, help, length, pickWrites, seededStepoverRange, SOURCE_SOLID, TOOL, type Op3dContext } from './common'

const d = DEFAULT_STEEP_SHALLOW3D_PARAMS
const OPTIONAL = ['params.finishDepth']

const params: readonly ParamDecl[] = [
  TOOL,
  SOURCE_SOLID,
  FACE_SCOPE,
  { key: 'params.useStockBoundary', type: 'boolean', default: d.useStockBoundary, labelKey: field('useStockBoundary'), helpKey: help('useStockBoundary'), group: 'geometry' },
  { key: 'params.thresholdDeg', type: 'number', quantity: 'angle', step: 1, range: { min: 0, max: 90 }, default: d.thresholdDeg, labelKey: field('thresholdDeg'), helpKey: help('thresholdDeg'), group: 'passes' },
  length('params.stepdown', 'steepStepdown', d.stepdown, 'passes', 0.05, 0.1),
  length('params.stepover', 'shallowStepover', d.stepover, 'passes', 0.05, 0.1),
  { key: 'params.angleDeg', type: 'number', quantity: 'angle', step: 5, range: { min: 0 }, default: d.angleDeg, labelKey: field('shallowAngle'), helpKey: help('passAngle'), group: 'passes' },
  length('params.stockToLeave', 'stockToLeave', d.stockToLeave, 'passes', 0, 0.05),
  length('params.finishDepth', 'finishDepth', d.finishDepth ?? null, 'passes', 0.01, 0.1),
  length('params.tolerance', 'tolerance', d.tolerance, 'options', 0.001, 0.01, { advanced: true }),
]

const librarySeed = (context: OpContext): number | undefined => {
  const mm = (context as Op3dContext).libraryStepoverMm
  return mm !== undefined && Number.isFinite(mm) && mm > 0 ? mm : undefined
}

export const STEEP_SHALLOW_3D_SCHEMA = defineOpSchema({ opType: 'steep_shallow_3d', params }, {
  storedReads: (key, stored) => !OPTIONAL.includes(key) || finiteNumber(stored),
  // the dialog starts a new Steep and shallow at the tool's library stepover, else the flat default
  seed: (context): ParamValues => {
    const mm = librarySeed(context)
    return mm !== undefined ? { 'params.stepover': mm } : {}
  },
  range: (key, context) => seededStepoverRange(key, librarySeed(context), { min: 0.05 }),
  linked(key, value, _before, op, context) {
    if (key === 'params.finishDepth') return finishDepthWrites(buildSteepShallow3dSmartIntent, value, op, context)
    return pickWrites(key, value) ?? blankAsUndefined(key, value, OPTIONAL) ?? {}
  },
})
