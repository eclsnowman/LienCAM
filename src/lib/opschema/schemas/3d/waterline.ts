// WO-3307 (UI M2 W2-2b): Waterline finish (waterline_3d). Every field the old Waterline editors
// show, declared once, with the wider of the two editors' limits (the dialog caps the stepdown and
// the wall stock at the tool diameter, the Properties panel does not).
import { DEFAULT_WATERLINE_PARAMS } from '../../../../kernel/parameterDefaults'
import { defaultWaterlineStepdownFor } from '../../../../kernel/schema'
import { buildWaterline3dSmartIntent } from '../../../cam/smartHeights'
import { defineOpSchema, type ParamDecl, type ParamValues } from '../..'
import { blankAsUndefined, choices, DIRECTIONS, FACE_SCOPE, field, finiteNumber, finishDepthWrites, help, length, pickWrites, SOURCE_SOLID, TOOL } from './common'

const d = DEFAULT_WATERLINE_PARAMS
const OPTIONAL = ['params.finishDepth']

const params: readonly ParamDecl[] = [
  TOOL,
  SOURCE_SOLID,
  FACE_SCOPE,
  { key: 'params.useStockBoundary', type: 'boolean', default: d.useStockBoundary, labelKey: field('useStockBoundary'), helpKey: help('useStockBoundary'), group: 'geometry' },
  length('params.stepdown', 'stepdown', d.stepdown, 'passes', 0.05, 0.1),
  length('params.stockToLeave', 'wallStockToLeave', d.stockToLeave, 'passes', 0, 0.05),
  { key: 'params.minSlopeDeg', type: 'number', quantity: 'angle', step: 1, range: { min: 0, max: 89 }, default: d.minSlopeDeg, labelKey: field('steepOnlyAbove'), helpKey: help('steepOnlyAbove'), group: 'passes' },
  length('params.finishDepth', 'finishDepth', d.finishDepth ?? null, 'passes', 0.01, 0.1),
  { key: 'params.order', type: 'choice', choices: choices('order', ['level', 'region']), default: d.order, labelKey: field('order'), helpKey: help('order'), group: 'passes' },
  { key: 'params.direction', type: 'choice', choices: choices('direction', DIRECTIONS), default: d.direction, labelKey: field('direction'), group: 'passes' },
  { key: 'params.flatAreaDetection', type: 'boolean', default: d.flatAreaDetection, labelKey: field('flatAreaDetection'), helpKey: help('flatAreaDetection'), group: 'passes' },
  length('params.tolerance', 'tolerance', d.tolerance, 'options', 0.001, 0.01, { advanced: true }),
]

export const WATERLINE_3D_SCHEMA = defineOpSchema({ opType: 'waterline_3d', params }, {
  storedReads: (key, stored) => !OPTIONAL.includes(key) || finiteNumber(stored),
  // the dialog starts a new Waterline's stepdown at 10% of the tool diameter (at least 0.2 mm)
  seed: ({ toolDiameter }): ParamValues => toolDiameter !== undefined && toolDiameter > 0
    ? { 'params.stepdown': defaultWaterlineStepdownFor(toolDiameter) }
    : {},
  linked(key, value, _before, op, context) {
    if (key === 'params.finishDepth') return finishDepthWrites(buildWaterline3dSmartIntent, value, op, context)
    return pickWrites(key, value) ?? blankAsUndefined(key, value, OPTIONAL) ?? {}
  },
})
