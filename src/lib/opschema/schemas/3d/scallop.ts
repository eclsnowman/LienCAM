// WO-3307 (UI M2 W2-2b): Scallop finish (scallop_3d). Every field the old editors show, declared
// once, with the wider of their limits (the dialog caps the scallop height at the tool radius, the
// Properties panel does not).
import { DEFAULT_SCALLOP3D_PARAMS } from '../../../../kernel/parameterDefaults'
import { buildScallop3dSmartIntent } from '../../../cam/smartHeights'
import { defineOpSchema, type ParamDecl } from '../..'
import { blankAsUndefined, choices, DIRECTIONS, FACE_SCOPE, field, finiteNumber, finishDepthWrites, help, length, pickWrites, SOURCE_SOLID, TOOL } from './common'

const d = DEFAULT_SCALLOP3D_PARAMS
const OPTIONAL = ['params.finishDepth']

const params: readonly ParamDecl[] = [
  TOOL,
  SOURCE_SOLID,
  FACE_SCOPE,
  { key: 'params.useStockBoundary', type: 'boolean', default: d.useStockBoundary, labelKey: field('useStockBoundary'), helpKey: help('useStockBoundary'), group: 'geometry' },
  length('params.scallopHeight', 'scallopHeight', d.scallopHeight, 'passes', 0.001, 0.005),
  length('params.stockToLeave', 'stockToLeave', d.stockToLeave, 'passes', 0, 0.05),
  length('params.finishDepth', 'finishDepth', d.finishDepth ?? null, 'passes', 0.01, 0.1),
  { key: 'params.direction', type: 'choice', choices: choices('direction', DIRECTIONS), default: d.direction, labelKey: field('direction'), group: 'passes' },
  length('params.tolerance', 'tolerance', d.tolerance, 'options', 0.001, 0.01, { advanced: true }),
]

export const SCALLOP_3D_SCHEMA = defineOpSchema({ opType: 'scallop_3d', params }, {
  storedReads: (key, stored) => !OPTIONAL.includes(key) || finiteNumber(stored),
  linked(key, value, _before, op, context) {
    if (key === 'params.finishDepth') return finishDepthWrites(buildScallop3dSmartIntent, value, op, context)
    return pickWrites(key, value) ?? blankAsUndefined(key, value, OPTIONAL) ?? {}
  },
})
