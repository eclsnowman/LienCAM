// WO-3283 (UI M2 W1-F): the Pocket pilot. Every field the old Pocket editors show (the New
// Operation dialog and the Properties panel), declared once, with the defaults a fresh Pocket
// gets, the unit each number measures and the limits the old fields hold it to. Where the two old
// editors use different limits the wider one is declared, because a value either editor accepts
// is one the software runs (LIENCAM.md rule 11). Heights are not parameters here: the operation's
// height plan is its own panel.
import type { HeightParams, LinkingParams } from '../../../types'
import { defaultLinking, defaultPasses, defaultPocketParams } from '../../../kernel/parameterDefaults'
import { deriveHeightPlaneOffsetUpdate } from '../../cam/heightReference'
import { getPocketEntryPolicy, isPocketEntryAllowed, normalizePocketEntryForFillStrategy } from '../../cam/pocketEntryPolicy'
import type { PocketParams } from '../../cam/types'
import { defineOpSchema, type ParamChoice, type ParamDecl, type ParamIssue, type ParamValues } from '..'
import type { MessageKey } from '../../../notices/types'
import { resolveMessage } from '../../../notices'

const AREA = 'ui2-opschema.wo3283'
const label = (name: string): MessageKey => `${AREA}:pocket.${name}`
const help = (name: string): MessageKey => `${AREA}:pocket.help.${name}`
const choices = (set: string, values: readonly string[]): readonly ParamChoice[] =>
  values.map(value => ({ value, labelKey: `${AREA}:choice.${set}.${value}` as MessageKey }))

/** Stored values the old fields fall back to (the clearance trim's default allowance and the
 *  floor hop's default height; pinned against their CAM constants by the WO-3283 test). */
const DEFAULT_CLEARANCE_ALLOWANCE_MM = 0.25
const DEFAULT_FLOOR_HOP_MM = 0.3
/** Gentle-corner engagement limits as fractions of the tool diameter (pinned against
 *  gentleEngagementLimits by the WO-3283 test). */
const GENTLE_ENGAGEMENT_MIN_RATIO = 0.05
const GENTLE_ENGAGEMENT_MAX_RATIO = 0.5
const CORNER_RELIEF_STYLES = ['none', 'dogbone', 't_bone', 'longest_edge'] as const
const ENTRY_TYPES = ['plunge', 'ramp_linear', 'ramp_helical'] as const

/** The linking the Properties panel edits from when a stored Pocket has none. */
const PANEL_LINKING: LinkingParams = {
  entryType: 'plunge',
  rampAngle: 2,
  rampLength: 5,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full',
  transitionType: 'safe_height',
}

const fill = (v: ParamValues) => v['params.fillStrategy'] as PocketParams['fillStrategy']
const entry = (v: ParamValues) => v['linking.entryType'] as LinkingParams['entryType']
const finishing = (v: ParamValues) => v['params.finishContour'] === true
const relieved = (v: ParamValues) => v['params.cornerRelief'] !== 'none'

const params: readonly ParamDecl[] = [
  // Tool
  { key: 'toolId', type: 'tool', default: null, labelKey: label('tool'), group: 'tool' },
  { key: 'params.clearanceAllowanceMm', type: 'number', quantity: 'length', step: 0.05, range: { min: 0 }, default: DEFAULT_CLEARANCE_ALLOWANCE_MM, labelKey: label('clearanceAllowanceMm'), helpKey: help('clearanceAllowanceMm'), group: 'tool' },
  // Geometry
  { key: 'params.boundarySource', type: 'choice', choices: choices('boundary', ['geometry', 'stock']), default: defaultPocketParams.boundarySource ?? 'geometry', labelKey: label('boundarySource'), group: 'geometry' },
  { key: 'params.geometryId', type: 'geometry', default: defaultPocketParams.geometryId, labelKey: label('geometry'), group: 'geometry', visible: v => v['params.boundarySource'] !== 'stock' },
  // Passes
  { key: 'params.direction', type: 'choice', choices: choices('direction', ['climb', 'conventional']), default: defaultPocketParams.direction, labelKey: label('direction'), group: 'passes' },
  { key: 'passes.stepdown', type: 'number', quantity: 'length', step: 0.5, range: { min: 0.01 }, default: defaultPasses.stepdown, labelKey: label('stepdown'), helpKey: help('stepdown'), group: 'passes' },
  { key: 'passes.stepover', type: 'number', quantity: 'length', step: 0.5, range: { min: 0.01 }, default: defaultPasses.stepover, labelKey: label('stepover'), helpKey: help('stepover'), group: 'passes' },
  { key: 'passes.stockToLeave', type: 'number', quantity: 'length', step: 0.05, range: { min: 0 }, default: defaultPasses.stockToLeave, labelKey: label('stockToLeave'), helpKey: help('stockToLeave'), group: 'passes' },
  { key: 'passes.floorStockToLeave', type: 'number', quantity: 'length', step: 0.05, range: { min: 0 }, default: defaultPasses.floorStockToLeave ?? 0, labelKey: label('floorStockToLeave'), group: 'passes' },
  { key: 'params.fillStrategy', type: 'choice', choices: choices('fill', ['outside_in', 'inside_out']), default: defaultPocketParams.fillStrategy ?? 'outside_in', labelKey: label('fillStrategy'), group: 'passes', advanced: true },
  { key: 'params.overlapMm', type: 'number', quantity: 'length', step: 0.5, range: { min: 0, max: 20 }, default: defaultPocketParams.overlapMm, labelKey: label('overlapMm'), group: 'passes', advanced: true },
  { key: 'params.stepoverLeadIn', type: 'choice', choices: choices('leadIn', ['none', 'arc']), default: defaultPocketParams.stepoverLeadIn, labelKey: label('stepoverLeadIn'), group: 'passes', advanced: true },
  { key: 'params.roundRingCorners', type: 'boolean', default: defaultPocketParams.roundRingCorners ?? false, labelKey: label('roundRingCorners'), group: 'passes', advanced: true },
  { key: 'params.orderStrategy', type: 'choice', choices: choices('order', ['by_region', 'by_depth']), default: defaultPocketParams.orderStrategy, labelKey: label('orderStrategy'), group: 'passes', advanced: true },
  { key: 'params.finishContour', type: 'boolean', default: defaultPocketParams.finishContour, labelKey: label('finishContour'), group: 'passes', advanced: true },
  { key: 'passes.finishPasses', type: 'integer', quantity: 'count', step: 1, range: { min: 1 }, default: defaultPasses.finishPasses, labelKey: label('finishPasses'), group: 'passes', advanced: true, visible: finishing },
  { key: 'passes.springPasses', type: 'integer', quantity: 'count', step: 1, range: { min: 0 }, default: defaultPasses.springPasses, labelKey: label('springPasses'), group: 'passes', advanced: true, visible: finishing },
  { key: 'params.stayDown', type: 'boolean', default: defaultPocketParams.stayDown, labelKey: label('stayDown'), group: 'passes', advanced: true, visible: finishing },
  { key: 'params.stayDownLift', type: 'number', quantity: 'length', step: 0.1, range: { min: 0.1, max: 10 }, default: defaultPocketParams.stayDownLift, labelKey: label('stayDownLift'), group: 'passes', advanced: true, visible: v => finishing(v) && v['params.stayDown'] === true },
  // Linking
  { key: 'linking.entryType', type: 'choice', choices: choices('entry', ENTRY_TYPES), default: normalizePocketEntryForFillStrategy(defaultPocketParams.fillStrategy, defaultLinking.entryType), labelKey: label('entryType'), helpKey: help('entryType'), group: 'linking' },
  { key: 'params.helixDiameter', type: 'number', quantity: 'percent', step: 5, range: { min: 10, max: 95 }, default: defaultPocketParams.helixDiameter, labelKey: label('helixDiameter'), helpKey: help('helixDiameter'), group: 'linking', visible: v => entry(v) === 'ramp_helical' },
  { key: 'linking.rampAngle', type: 'number', quantity: 'angle', step: 0.5, range: { min: 0.5, max: 30 }, default: defaultLinking.rampAngle, labelKey: label('rampAngle'), helpKey: help('rampAngle'), group: 'linking', visible: v => entry(v) === 'ramp_helical' || entry(v) === 'ramp_linear' },
  { key: 'params.entryClearance', type: 'number', quantity: 'length', step: 0.5, range: { min: 0 }, default: defaultPocketParams.entryClearance ?? 1, labelKey: label('entryClearance'), helpKey: help('entryClearance'), group: 'linking', visible: v => entry(v) === 'ramp_helical' },
  { key: 'linking.floorHopMm', type: 'number', quantity: 'length', step: 0.1, range: { min: 0 }, default: defaultLinking.floorHopMm ?? DEFAULT_FLOOR_HOP_MM, labelKey: label('floorHop'), helpKey: help('floorHop'), group: 'linking' },
  // Feeds
  { key: 'params.slotFeedPercent', type: 'number', quantity: 'percent', step: 5, range: { min: 1, max: 100 }, default: defaultPocketParams.slotFeedPercent ?? 100, labelKey: label('slotFeedPercent'), helpKey: help('slotFeedPercent'), group: 'feeds' },
  // Corners
  { key: 'params.cornerRelief', type: 'choice', choices: choices('corner', CORNER_RELIEF_STYLES), default: defaultPocketParams.cornerRelief ?? 'none', labelKey: label('cornerRelief'), helpKey: help('cornerRelief'), group: 'custom:corners', advanced: true },
  { key: 'params.cornerReliefGentle', type: 'boolean', default: defaultPocketParams.cornerReliefGentle ?? false, labelKey: label('cornerReliefGentle'), group: 'custom:corners', advanced: true, visible: relieved },
  // null follows the tool (a quarter of its diameter), as an absent value does in the old editors
  { key: 'params.cornerReliefEngagement', type: 'number', quantity: 'length', step: 0.1, default: defaultPocketParams.cornerReliefEngagement ?? null, labelKey: label('cornerReliefEngagement'), helpKey: help('cornerReliefEngagement'), group: 'custom:corners', advanced: true, visible: v => relieved(v) && v['params.cornerReliefGentle'] === true },
]

/** The stored entry its fill strategy cannot run is the one cross-field problem: the old
 *  editors flag it, and the toolpath refuses it (assertPocketEntryAllowed). */
function checkEntry(values: ParamValues): readonly ParamIssue[] {
  if (isPocketEntryAllowed(fill(values), entry(values))) return []
  const name = (set: string, value: unknown) => resolveMessage(`${AREA}:choice.${set}.${String(value)}` as MessageKey)
  const allowed = getPocketEntryPolicy(fill(values)).allowed.map(e => name('entry', e)).join(resolveMessage(`${AREA}:issue.or`))
  return [{
    key: 'linking.entryType',
    reason: `${AREA}:issue.entryNotForFill`,
    params: { fill: name('fill', fill(values) ?? 'outside_in'), entry: name('entry', entry(values)), allowed },
  }]
}

export const POCKET_SCHEMA = defineOpSchema({ opType: 'pocket_2d', params }, {
  absent: {
    'params.boundarySource': 'geometry',
    'params.fillStrategy': 'outside_in',
    'params.stepoverLeadIn': 'none',
    'params.helixDiameter': 90,
    'params.stayDownLift': 1,
    'params.entryClearance': 1,
    'params.slotFeedPercent': 100,
    'params.cornerRelief': 'none',
    'params.cornerReliefGentle': false,
    'params.cornerReliefEngagement': null,
    'params.roundRingCorners': false,
    'params.stayDown': false,
    'params.clearanceAllowanceMm': DEFAULT_CLEARANCE_ALLOWANCE_MM,
    'passes.floorStockToLeave': 0,
    'linking.floorHopMm': DEFAULT_FLOOR_HOP_MM,
  },
  // older Pockets kept the floor stock on the operation's own params; the dialog shows it and the
  // toolpath cuts it (passes ?? params ?? 0)
  storedElsewhere: { 'passes.floorStockToLeave': 'params.floorStockToLeave' },
  containerFallback: { linking: { ...PANEL_LINKING } },
  // the old lists offer only the entries the fill strategy runs
  choices: (key, values) => key === 'linking.entryType' ? getPocketEntryPolicy(fill(values)).allowed : undefined,
  // the floor hop and the shank clearance read a negative or non-number as their default
  storedReads: (key, stored) => key !== 'linking.floorHopMm' && key !== 'params.clearanceAllowanceMm'
    || (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0),
  // the dialog starts a new Pocket's stepover at 35% of the tool diameter, to 0.1 mm
  seed: ({ toolDiameter }): ParamValues => toolDiameter !== undefined && toolDiameter > 0
    ? { 'passes.stepover': Math.round(toolDiameter * 0.35 * 10) / 10 }
    : {},
  // both old editors hold the gentle-corner engagement to 5-50% of the tool diameter
  range: (key, { toolDiameter }) => key === 'params.cornerReliefEngagement' && toolDiameter !== undefined && toolDiameter > 0
    ? { min: toolDiameter * GENTLE_ENGAGEMENT_MIN_RATIO, max: toolDiameter * GENTLE_ENGAGEMENT_MAX_RATIO }
    : undefined,
  linked(key, value, before, op, context) {
    switch (key) {
      // the Properties panel never stores a negative hop
      case 'linking.floorHopMm':
        return typeof value === 'number' ? { [key]: Math.max(0, value) } : {}
      // the dialog moves the entry to one the new fill strategy runs; on a new Pocket it also
      // turns stay-down on for outside-in and off for inside-out
      case 'params.fillStrategy': {
        const strategy = value as PocketParams['fillStrategy']
        const out: Record<string, unknown> = {}
        const next = normalizePocketEntryForFillStrategy(strategy, entry(before))
        if (next !== entry(before)) out['linking.entryType'] = next
        if (context.creating) {
          out['params.stayDown'] = strategy === 'outside_in'
          if (strategy === 'outside_in') out['params.stayDownLift'] = before['params.stayDownLift']
        }
        return out
      }
      // the dialog's boundary buttons: the stock clears the picked geometry and starts at the
      // stock top; the picked geometry puts the bottom on it and moves the height intent with it
      case 'params.boundarySource': {
        if (value === 'stock') {
          return { 'params.geometryId': '', 'params.loopIds': [], 'params.heightReference': 'stock_top', 'params.planeOffset': 0 }
        }
        const stored = (op.params ?? {}) as PocketParams
        const heights = op.heights as HeightParams | undefined
        const out: Record<string, unknown> = { 'params.heightReference': 'geometry_face', 'params.planeOffset': 0 }
        if (heights) {
          const update = deriveHeightPlaneOffsetUpdate('pocket_2d', heights, { ...stored, heightReference: 'geometry_face' }, 'geometry_face', 0)
          for (const [field, v] of Object.entries(update)) out[`heights.${field}`] = v
        }
        return out
      }
      default:
        return {}
    }
  },
  check: checkEntry,
})
