// WO-3307 (UI M2 W2-2b): Adaptive rough (adaptive_3d). Every field the old Adaptive editors show,
// declared once; both editors hold them to the same limits. Two stored forms differ from what the
// old fields show: the wall-ride limit is stored as a factor of the straight distance (the old
// fields show it as a percent), and a grid cell size of 0 or less is the automatic grid (the old
// editors show it as a checkbox), so the field reads blank for automatic.
import { DEFAULT_ADAPTIVE3D_PARAMS } from '../../../../kernel/parameterDefaults'
import { defineOpSchema, type OpContext, type ParamDecl, type ParamValues } from '../..'
import { blankAsUndefined, choices, DIRECTIONS, field, finiteNumber, help, length, pickWrites, seededStepoverRange, SOURCE_SOLID, TOOL, type Op3dContext } from './common'

const d = DEFAULT_ADAPTIVE3D_PARAMS
/** The wall-ride factor both old editors store when the typed percent is not a positive number. */
const DEFAULT_WALL_RIDE_FACTOR = 2
const OPTIONAL = ['params.stockEdgeOvershoot']
const following = (v: ParamValues) => v['params.integralWallFollow'] === true

const params: readonly ParamDecl[] = [
  TOOL,
  SOURCE_SOLID,
  { key: 'params.useStockBoundary', type: 'boolean', default: d.useStockBoundary, labelKey: field('clearAllStock'), helpKey: help('clearAllStock'), group: 'geometry' },
  // blank = auto (the tool radius); only the full-stock clear uses it
  length('params.stockEdgeOvershoot', 'stockEdgeOvershoot', d.stockEdgeOvershoot ?? null, 'geometry', 0, 0.1, { visible: v => v['params.useStockBoundary'] === true }),
  length('params.maxStepdown', 'maxStepdown', d.maxStepdown, 'passes', 0.1, 0.5),
  { key: 'params.stepover', type: 'number', quantity: 'none', step: 0.05, precision: 2, range: { min: 0.05, max: 1 }, default: d.stepover, labelKey: field('stepoverFraction'), helpKey: help('stepoverFraction'), group: 'passes' },
  { key: 'params.millingDirection', type: 'choice', choices: choices('direction', DIRECTIONS), default: d.millingDirection, labelKey: field('direction'), group: 'passes' },
  { key: 'params.intermediateStepdown', type: 'boolean', default: d.intermediateStepdown, labelKey: field('reduceStairSteps'), helpKey: help('reduceStairSteps'), group: 'passes' },
  length('params.radialStockToLeave', 'radialStockToLeave', d.radialStockToLeave, 'passes', 0, 0.1),
  length('params.axialStockToLeave', 'axialStockToLeave', d.axialStockToLeave, 'passes', 0, 0.1),
  length('params.helixDiameter', 'helixDiameter', d.helixDiameter, 'linking', 0.5, 0.5),
  { key: 'params.helixAngleDeg', type: 'number', quantity: 'angle', step: 0.5, range: { min: 0.5, max: 30 }, default: d.helixAngleDeg, labelKey: field('helixAngle'), helpKey: help('helixAngle'), group: 'linking' },
  length('params.wallLeadInRadius', 'wallLeadInRadius', d.wallLeadInRadius, 'linking', 0, 0.5, { advanced: true }),
  length('params.wallLeadOutRadius', 'wallLeadOutRadius', d.wallLeadOutRadius, 'linking', 0, 0.5, { advanced: true }),
  { key: 'params.loopbackFilletPct', type: 'number', quantity: 'percent', step: 5, range: { min: 5, max: 100 }, default: d.loopbackFilletPct, labelKey: field('loopbackFillet'), helpKey: help('loopbackFillet'), group: 'linking', advanced: true },
  { key: 'params.integralWallFollow', type: 'boolean', default: d.integralWallFollow, labelKey: field('integralWallFollow'), helpKey: help('integralWallFollow'), group: 'linking', advanced: true },
  { key: 'params.integralWallFollowLengthFactor', type: 'number', quantity: 'none', step: 0.1, precision: 2, range: { min: 0.1, max: 10 }, default: d.integralWallFollowLengthFactor, labelKey: field('wallRideFactor'), helpKey: help('wallRideFactor'), group: 'linking', advanced: true, visible: following },
  length('params.tolerance', 'tolerance', d.tolerance, 'options', 0.001, 0.01, { advanced: true }),
  // blank = automatic grid (stored as 0)
  length('params.cellSize', 'cellSize', null, 'options', 0.1, 0.1, { advanced: true }),
]

const librarySeed = (context: OpContext): number | undefined => {
  const { libraryStepoverMm: mm, toolDiameter } = context as Op3dContext
  if (mm === undefined || !Number.isFinite(mm) || mm <= 0 || toolDiameter === undefined || !(toolDiameter > 0)) return undefined
  return Math.min(1, Math.max(0.01, Math.round((mm / toolDiameter) * 100) / 100))
}

export const ADAPTIVE_3D_SCHEMA = defineOpSchema({ opType: 'adaptive_3d', params }, {
  storedReads: (key, stored) => key === 'params.cellSize'
    ? finiteNumber(stored) && (stored as number) > 0
    : !OPTIONAL.includes(key) || finiteNumber(stored),
  // the dialog starts a new Adaptive rough at the tool's library stepover as a fraction of its
  // diameter (to 0.01, inside 0.01..1), else the flat default
  seed: (context): ParamValues => {
    const fraction = librarySeed(context)
    return fraction !== undefined ? { 'params.stepover': fraction } : {}
  },
  range: (key, context) => seededStepoverRange(key, librarySeed(context), { min: 0.05, max: 1 }),
  linked(key, value) {
    switch (key) {
      // both old editors store the default factor for a typed value that is not a positive number
      case 'params.integralWallFollowLengthFactor':
        return { [key]: typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_WALL_RIDE_FACTOR }
      // a blank grid size is the automatic grid, stored as 0
      case 'params.cellSize':
        return { [key]: typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0 }
      default:
        return pickWrites(key, value) ?? blankAsUndefined(key, value, OPTIONAL) ?? {}
    }
  },
})
