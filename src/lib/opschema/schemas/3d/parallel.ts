// WO-3307 (UI M2 W2-2b): Parallel finish (parallel_3d). Every field the old Parallel editors show
// (the New Operation dialog and the Properties panel), declared once. Where the two editors hold a
// field to different limits the wider one is declared (LIENCAM.md rule 11): the dialog caps the
// stepover and the surface stock at the tool diameter, the Properties panel does not.
import { DEFAULT_PARALLEL3D_PARAMS } from '../../../../kernel/parameterDefaults'
import { buildParallel3dSmartIntent } from '../../../cam/smartHeights'
import { defineOpSchema, type OpContext, type ParamDecl, type ParamValues } from '../..'
import { blankAsUndefined, FACE_SCOPE, field, finiteNumber, finishDepthWrites, help, length, pickWrites, seededStepoverRange, SOURCE_SOLID, TOOL, type Op3dContext } from './common'

const d = DEFAULT_PARALLEL3D_PARAMS
const OPTIONAL = ['params.finishDepth', 'params.stockEdgeOvershoot']

const params: readonly ParamDecl[] = [
  TOOL,
  SOURCE_SOLID,
  FACE_SCOPE,
  { key: 'params.useStockBoundary', type: 'boolean', default: d.useStockBoundary, labelKey: field('useStockBoundary'), helpKey: help('useStockBoundary'), group: 'geometry' },
  // blank = auto (the tool radius); shown by the dialog only
  length('params.stockEdgeOvershoot', 'stockEdgeOvershoot', d.stockEdgeOvershoot ?? null, 'geometry', 0, 0.1, { advanced: true }),
  length('params.stepover', 'stepover', d.stepover, 'passes', 0.05, 0.1),
  { key: 'params.angleDeg', type: 'number', quantity: 'angle', step: 5, range: { min: 0, max: 180 }, default: d.angleDeg, labelKey: field('passAngle'), helpKey: help('passAngle'), group: 'passes' },
  length('params.surfaceStockToLeave', 'surfaceStockToLeave', d.surfaceStockToLeave ?? 0, 'passes', 0, 0.05),
  // blank = the full surface
  length('params.finishDepth', 'finishDepth', d.finishDepth ?? null, 'passes', 0.01, 0.1),
  length('params.tolerance', 'tolerance', d.tolerance, 'options', 0.001, 0.01, { advanced: true }),
]

const librarySeed = (context: OpContext): number | undefined => {
  const mm = (context as Op3dContext).libraryStepoverMm
  return mm !== undefined && Number.isFinite(mm) && mm > 0 ? mm : undefined
}

export const PARALLEL_3D_SCHEMA = defineOpSchema({ opType: 'parallel_3d', params }, {
  // both old editors read an absent surface stock as 0
  absent: { 'params.surfaceStockToLeave': 0 },
  storedReads: (key, stored) => !OPTIONAL.includes(key) || finiteNumber(stored),
  // the dialog starts a new Parallel at the tool's library stepover, else the flat default
  seed: (context): ParamValues => {
    const mm = librarySeed(context)
    return mm !== undefined ? { 'params.stepover': mm } : {}
  },
  range: (key, context) => seededStepoverRange(key, librarySeed(context), { min: 0.05 }),
  linked(key, value, _before, op, context) {
    if (key === 'params.finishDepth') return finishDepthWrites(buildParallel3dSmartIntent, value, op, context)
    return pickWrites(key, value) ?? blankAsUndefined(key, value, OPTIONAL) ?? {}
  },
})
