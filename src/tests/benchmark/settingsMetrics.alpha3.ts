// WO-2900: observations only. No product defaults, warnings, or motion decisions.
// WO-3058: machine fields come from a public fixture, not the private LienCNCV2 profile.
import type { Tool, ToolpathMove } from '../../types'
import { resolveFeedrates, resolveMoveFeedrate } from '../../lib/cam/feedrates'
import profile from '../fixtures/benchmark/settingsMetricsProfile.json'
import windowsJson from './settingsWindows.alpha3.json'
import { notApplicable, type MetricValue } from './metricRegistry'
import type { ScorecardRow } from './chainRunner'
import { measurePathEngagement } from '../../cam3d/rough/pathEngagement'
import type { Box3, ZDexelField } from '../../cam3d/stock'
import type { CutterSpec } from '../../cam3d/kernel/types'
import { toIrMoves } from './metrics'

export type Band = [number, number]
export interface WindowRule {
  id: string
  applies_to: { material: string; tool_type: string; diameter_mm: Band; strategy: string;
    flutes?: number[]; tool_family?: string; machine?: string; rigidity_class?: string; coating?: string }
  outputs: { vc_m_min?: Band; hex_mm?: Band; ae_frac_D?: Band; ap_frac_D?: Band; hex_floor_mm?: number }
  adjust: { rigidity?: { class: string; ae: number; ap: number; fz: number } } 
  source: { url: string; supports: string }[]
  evaluation: { tier: 'A' | 'B' | 'C' | 'D'; applicability: string; outcome_evidence?: string }
  confidence: 'EXT-starting-window' | 'published-tested' | 'locally-confirmed'
  confirmedGood: boolean
}
export interface WindowTable { ruleset: { id: string; version: string; accessed: string }; rules: WindowRule[] }
export function validateWindows(value: unknown): asserts value is WindowTable {
  const table = value as WindowTable
  if (!table?.ruleset?.id || !table.ruleset.version || !/^\d{4}-\d{2}-\d{2}$/.test(table.ruleset.accessed) || !Array.isArray(table.rules)) throw new Error('settings windows: ruleset metadata required')
  const ids = new Set<string>()
  for (const r of table.rules) {
    const a = r.applies_to
    if (!r.id || ids.has(r.id) || !a?.material || !a.tool_type || !a.strategy || !a.diameter_mm ||
        !r.source?.length || r.source.some(s => !/^https:\/\//.test(s.url) || !s.supports) ||
        !['A', 'B', 'C', 'D'].includes(r.evaluation?.tier) || !r.evaluation.applicability ||
        !['EXT-starting-window', 'published-tested', 'locally-confirmed'].includes(r.confidence) ||
        typeof r.confirmedGood !== 'boolean' || !r.adjust || !r.outputs) throw new Error(`settings windows: invalid/source-less rule ${r.id}`)
    ids.add(r.id)
    for (const b of [a.diameter_mm, ...Object.values(r.outputs).filter((value): value is Band => Array.isArray(value))]) {
      if (b.length !== 2 || !b.every(n => Number.isFinite(n) && n >= 0) || b[1] < b[0]) throw new Error(`settings windows: invalid band ${r.id}`)
    }
    if (r.evaluation.tier === 'D' && Object.keys(r.outputs).length) throw new Error(`settings windows: tier D cannot set numeric limits ${r.id}`)
    if (r.outputs.hex_floor_mm !== undefined && (!(r.outputs.hex_floor_mm > 0) || !r.confirmedGood || r.confidence !== 'locally-confirmed')) throw new Error(`settings windows: uncalibrated floor ${r.id}`)
    if (r.adjust.rigidity && (!r.adjust.rigidity.class || ![r.adjust.rigidity.ae, r.adjust.rigidity.ap, r.adjust.rigidity.fz].every(n => Number.isFinite(n) && n > 0 && n <= 1))) throw new Error(`settings windows: invalid rigidity calibration ${r.id}`)
    if (r.confirmedGood && (r.confidence !== 'locally-confirmed' || !r.evaluation.outcome_evidence)) throw new Error(`settings windows: confirmation evidence required ${r.id}`)
  }
}
validateWindows(windowsJson)
export const SETTINGS_WINDOWS: WindowTable = windowsJson
export const SETTINGS_KEYS = ['M-SET-1', 'M-SET-2', 'M-SET-3', 'M-SET-4', 'M-SET-5', 'M-SET-6', 'M-SET-7', 'M-LOAD-6'] as const
const round = (n: number) => Math.round(n * 1e9) / 1e9
const positive = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined
const na = (why: string) => notApplicable(`n/a: ${why}`)
export function radialFactor(diameter: number, ae: number): number {
  if (!(diameter > 0) || !Number.isFinite(diameter) || ae < 0 || !Number.isFinite(ae)) throw new Error('invalid radial geometry')
  const ratio = ae / diameter
  return ratio > 0.5 ? 1 : 2 * Math.sqrt(ratio * (1 - ratio))
}
export function effectiveDiameter(diameter: number, ap: number, cornerRadius = diameter / 2): number {
  if (!(diameter > 0) || !Number.isFinite(diameter) || ap < 0 || !Number.isFinite(ap) || !Number.isFinite(cornerRadius) || cornerRadius < 0 || cornerRadius > diameter / 2) throw new Error('invalid contact geometry')
  return ap >= cornerRadius ? diameter : diameter - 2 * cornerRadius + 2 * Math.sqrt(cornerRadius ** 2 - (cornerRadius - ap) ** 2)
}
export function coneDiameter(tip: number, depth: number, includedAngle: number): number {
  if (![tip, depth, includedAngle].every(Number.isFinite) || tip < 0 || depth < 0 || !(includedAngle > 0 && includedAngle < 180)) throw new Error('invalid cone geometry')
  return tip + 2 * depth * Math.tan(includedAngle * Math.PI / 360)
}
export function scallopStep(radius: number, height: number): number | undefined {
  return radius > 0 && height > 0 && height <= radius ? 2 * Math.sqrt(radius ** 2 - (radius - height) ** 2) : undefined
}
export interface EngagementSample {
  lengthMm: number; aeMm: number; feed: number; rpm: number
  contactDepthMm?: number; coneBand?: { tipDiameter: number; depth: number; includedAngle: number }
}
export interface SettingsInput {
  material: string; strategy: string; tool: Tool; rpm?: number; feed?: number; aeMm?: number; apMm?: number
  finishingStepMm?: number; scallopHeightMm?: number
  machineId?: string; toolFamily?: string; rigidityClass?: string; synthetic?: boolean; fallback?: boolean
  emitted?: readonly ToolpathMove[]; replay?: readonly EngagementSample[]; unavailable?: string
  provenance?: Record<string, { ruleId: string; version: string }>
  // Optional, measured spindle facts only. No generic router power percentage.
  power?: { ratedKw: number; ratedRpm: number; source: string; minimumFraction?: number }
}
export function matchingRules(input: SettingsInput, table = SETTINGS_WINDOWS): WindowRule[] {
  return table.rules.filter(r => {
    const a = r.applies_to
    return a.material === input.material && a.tool_type === input.tool.type && a.strategy === input.strategy &&
      input.tool.diameter >= a.diameter_mm[0] && input.tool.diameter <= a.diameter_mm[1] &&
      (!a.flutes || a.flutes.includes(input.tool.numberOfFlutes)) &&
      (!a.tool_family || a.tool_family === input.toolFamily) && (!a.machine || a.machine === input.machineId) &&
      (!a.rigidity_class || a.rigidity_class === input.rigidityClass) && (!a.coating || a.coating === input.tool.coating)
  })
}
export function defaultRecipeEligible(rule: WindowRule): boolean {
  return rule.confirmedGood && rule.confidence === 'locally-confirmed' && rule.evaluation.tier !== 'D' &&
    rule.evaluation.applicability === 'evaluated' && Boolean(rule.evaluation.outcome_evidence) &&
    Boolean(rule.applies_to.tool_family && rule.applies_to.machine && rule.applies_to.flutes?.length && rule.applies_to.coating)
}
function adjustedBand(rule: WindowRule, key: keyof WindowRule['outputs'], rigidity?: string): Band | undefined {
  const b = rule.outputs[key]
  if (!Array.isArray(b)) return undefined
  const adjustment = rule.adjust.rigidity
  if (adjustment && rigidity !== adjustment.class) return undefined
  const multiplier = adjustment ? (key === 'ae_frac_D' ? adjustment.ae : key === 'ap_frac_D' ? adjustment.ap : key === 'hex_mm' ? adjustment.fz : 1) : 1
  return [b[0] * multiplier, b[1] * multiplier]
}
function compare(value: number | undefined, rules: WindowRule[], key: keyof WindowRule['outputs'], rigidity?: string, version = SETTINGS_WINDOWS.ruleset.version) {
  return rules.flatMap(rule => {
    const band = adjustedBand(rule, key, rigidity)
    return value === undefined || !band ? [] : [{ ruleId: rule.id, version,
      value: round(value), band, inside: value >= band[0] && value <= band[1], confidence: rule.confidence,
      source: rule.source, defaultEligible: defaultRecipeEligible(rule) }]
  })
}
/** Peak axis velocity on a straight move or an XY helix, including arc tangents. */
export function machineViolations(rpm: number, moves: readonly ToolpathMove[], machine = profile): number {
  let count = rpm < machine.minSpindleRpm || rpm > machine.maxSpindleRpm ? 1 : 0
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i], p = moves[i - 1]
    if (m.type === 'rapid' || m.feed === undefined) continue
    const dx = m.x - p.x, dy = m.y - p.y, dz = m.z - p.z
    let length = Math.hypot(dx, dy, dz)
    let vx = Math.abs(dx), vy = Math.abs(dy), vz = Math.abs(dz)
    if (m.type === 'arc_cw' || m.type === 'arc_ccw') {
      if (m.cx === undefined || m.cy === undefined) throw new Error('axis limits: arc contact/centre unavailable')
      const radius = Math.hypot(p.x - m.cx, p.y - m.cy)
      const a = Math.atan2(p.y - m.cy, p.x - m.cx)
      const b = Math.atan2(m.y - m.cy, m.x - m.cx)
      const turn = Math.PI * 2
      const normalized = (angle: number) => ((angle % turn) + turn) % turn
      const distance = (angle: number) => normalized(m.type === 'arc_cw' ? a - angle : angle - a)
      const sweep = distance(b) || turn
      const contains = (angle: number) => distance(angle) <= sweep + 1e-12
      const planar = radius * sweep
      length = Math.hypot(planar, dz)
      vx = planar * Math.max(Math.abs(Math.sin(a)), Math.abs(Math.sin(b)), ...[Math.PI / 2, 3 * Math.PI / 2].map(angle => contains(angle) ? 1 : 0))
      vy = planar * Math.max(Math.abs(Math.cos(a)), Math.abs(Math.cos(b)), ...[0, Math.PI].map(angle => contains(angle) ? 1 : 0))
      vz = Math.abs(dz)
    }
    if (length > 0 && (m.feed * vx / length > machine.axisLimits.x.maxCutting ||
      m.feed * vy / length > machine.axisLimits.y.maxCutting || m.feed * vz / length > machine.axisLimits.z.maxCutting)) count++
  }
  return count
}

function contact(input: SettingsInput, ap = input.apMm, cone?: EngagementSample['coneBand']): number | undefined {
  if (input.tool.type === 'ball_end_mill') return ap === undefined ? undefined : effectiveDiameter(input.tool.diameter, ap)
  if (input.tool.type === 'bull_nose') return ap === undefined || input.tool.cornerRadius === undefined ? undefined : effectiveDiameter(input.tool.diameter, ap, input.tool.cornerRadius)
  if (['v_bit', 'chamfer_mill'].includes(input.tool.type)) return cone ? coneDiameter(cone.tipDiameter, cone.depth, cone.includedAngle) : undefined
  return input.tool.type === 'flat_end_mill' ? input.tool.diameter : undefined
}
function thickness(input: SettingsInput, feed: number | undefined, rpm: number | undefined, ae: number | undefined, cone?: EngagementSample['coneBand']): number | undefined {
  if (!positive(feed) || !positive(rpm) || !positive(input.tool.numberOfFlutes) || ae === undefined || contact(input, input.apMm, cone) === undefined) return undefined
  const angle = cone ? Math.cos(cone.includedAngle * Math.PI / 360) : 1
  const radialDiameter = cone ? coneDiameter(cone.tipDiameter, cone.depth, cone.includedAngle) : input.tool.diameter
  if (!(radialDiameter > 0)) return undefined
  return feed! / (input.tool.numberOfFlutes * rpm!) * radialFactor(radialDiameter, ae) * angle
}
export function collectSettings(input: SettingsInput, table = SETTINGS_WINDOWS) {
  const rules = matchingRules(input, table)
  const metrics: Record<string, MetricValue> = Object.fromEntries(SETTINGS_KEYS.map(k => [k, na('no window')]))
  const labels = [input.synthetic ? 'synthetic tool' : 'library tool', ...(input.fallback ? ['fallback feed'] : [])]
  const de = contact(input)
  const replaySpeeds = input.replay?.map(sample => {
    const diameter = contact(input, sample.contactDepthMm, sample.coneBand)
    return { value: diameter === undefined || !positive(sample.rpm) ? undefined : Math.PI * diameter * sample.rpm / 1000, length: sample.lengthMm }
  })
  const speedLength = replaySpeeds?.reduce((sum, sample) => sum + sample.length, 0) ?? 0
  const replayVc = replaySpeeds?.length && speedLength > 0 && replaySpeeds.every(sample => sample.value !== undefined && sample.length > 0)
    ? replaySpeeds.reduce((sum, sample) => sum + sample.value! * sample.length, 0) / speedLength : undefined
  const vc = replayVc ?? (de !== undefined && positive(input.rpm) ? Math.PI * de * input.rpm! / 1000 : undefined)
  const fz = positive(input.feed) && positive(input.rpm) && positive(input.tool.numberOfFlutes) ? input.feed! / (input.tool.numberOfFlutes * input.rpm!) : undefined
  const hex = thickness(input, input.feed, input.rpm, input.aeMm)
  const ae = input.aeMm === undefined ? undefined : input.aeMm / input.tool.diameter
  const ap = input.apMm === undefined ? undefined : input.apMm / input.tool.diameter
  const comparisons = {
    vc: compare(vc, rules, 'vc_m_min', input.rigidityClass, table.ruleset.version), hex: compare(hex, rules, 'hex_mm', input.rigidityClass, table.ruleset.version),
    ae: compare(ae, rules, 'ae_frac_D', input.rigidityClass, table.ruleset.version), ap: compare(ap, rules, 'ap_frac_D', input.rigidityClass, table.ruleset.version),
  }
  if (input.emitted && positive(input.rpm) && !input.unavailable && input.emitted.every(move => move.type === 'rapid' || positive(move.feed))) {
    metrics['M-SET-1'] = machineViolations(input.rpm!, input.emitted)
  } else metrics['M-SET-1'] = na(input.unavailable ?? 'emitted move feeds/axis directions not captured; rpm alone is not full machine-limit evidence')
  if (comparisons.vc.length) metrics['M-SET-2'] = round(vc!)
  else if (de === undefined && replayVc === undefined) metrics['M-SET-2'] = na('contact depth/engaged cone band unavailable; nominal diameter is not contact evidence')
  if (comparisons.hex.length) metrics['M-SET-3'] = round(hex!)
  else if (input.aeMm === undefined) metrics['M-SET-3'] = na('programmed radial engagement unavailable')
  if (comparisons.ae.length) metrics['M-SET-4'] = round(ae!)
  if (comparisons.ap.length) metrics['M-SET-5'] = round(ap!)
  const step = input.scallopHeightMm === undefined ? undefined : scallopStep(input.tool.diameter / 2, input.scallopHeightMm)
  metrics['M-SET-6'] = input.tool.type === 'ball_end_mill' && step && input.finishingStepMm !== undefined
    ? round(input.finishingStepMm / step) : na('no explicit finishing stepover/scallop target pair with ball contact geometry')
  const chosen = ['rpm', 'feed', 'aeMm', 'apMm', 'finishingStepMm', 'scallopHeightMm'] as const
  const settings = chosen.filter(key => input[key] !== undefined)
  metrics['M-SET-7'] = settings.length ? settings.filter(key => {
    const p = input.provenance?.[key]
    return p?.version === table.ruleset.version && rules.some(rule => rule.id === p.ruleId)
  }).length / settings.length : 0
  const confirmedDefaultShare = settings.length ? settings.filter(key => {
    const p = input.provenance?.[key]
    return p?.version === table.ruleset.version && rules.some(rule => rule.id === p.ruleId && defaultRecipeEligible(rule))
  }).length / settings.length : 0
  const replayComparisons = rules.flatMap(rule => {
    const band = adjustedBand(rule, 'hex_mm', input.rigidityClass)
    if (!band || !input.replay?.length) return []
    let total = 0, inside = 0, belowFloor = 0
    for (const sample of input.replay) {
      const sampleInput = { ...input, apMm: sample.contactDepthMm }
      const h = thickness(sampleInput, sample.feed, sample.rpm, sample.aeMm, sample.coneBand)
      if (h === undefined || !(sample.lengthMm > 0)) return [] // partial evidence cannot report a full share
      total += sample.lengthMm
      if (h >= band[0] && h <= band[1]) inside += sample.lengthMm
      if (rule.outputs.hex_floor_mm !== undefined && h < rule.outputs.hex_floor_mm) belowFloor += sample.lengthMm
    }
    return total ? [{ ruleId: rule.id, version: table.ruleset.version, share: round(inside / total),
      belowFloorShare: rule.outputs.hex_floor_mm === undefined ? na('no calibrated rubbing floor') : round(belowFloor / total), source: rule.source }] : []
  })
  metrics['M-LOAD-6'] = replayComparisons.length === 1 ? replayComparisons[0].share : na(
    !input.replay?.length ? 'no replay series with per-move feed/contact evidence' : replayComparisons.length > 1 ? 'multiple windows; see separate shares in settingsMeasurement' : 'no window or incomplete replay/contact evidence')
  if (input.unavailable) for (const key of SETTINGS_KEYS) metrics[key] = na(input.unavailable)
  const power = input.power && positive(input.rpm) && positive(input.power.ratedKw) && positive(input.power.ratedRpm) && input.power.source &&
    (input.power.minimumFraction === undefined || (input.power.minimumFraction > 0 && input.power.minimumFraction <= 1)) ? { availableKw: input.power.ratedKw * Math.min(1, input.rpm! / input.power.ratedRpm),
    minimumRpm: input.power.minimumFraction === undefined ? undefined : input.power.ratedRpm * input.power.minimumFraction,
    belowMinimum: input.power.minimumFraction === undefined ? undefined : input.rpm! < input.power.ratedRpm * input.power.minimumFraction, source: input.power.source } : na('no measured spindle curve/base speed/power')
  return { metrics, measurement: { ruleset: table.ruleset, labels, rpm: input.rpm, programmedFeed: input.feed,
    effectiveDiameterMm: de, vcMMin: vc === undefined ? undefined : round(vc), fzMm: fz === undefined ? undefined : round(fz),
    confirmedDefaultShare, predictedHexMm: hex === undefined ? undefined : round(hex), programmedAeFracD: ae, programmedApFracD: ap,
    spindleViolation: positive(input.rpm) ? machineViolations(input.rpm!, []) : na('rpm not captured'), comparisons, replayComparisons,
    fluteLengthExceeded: input.apMm === undefined || !positive(input.tool.fluteLength) ? na('depth or flute length unknown') : input.apMm > input.tool.fluteLength!,
    rigidity: input.rigidityClass ?? 'unknown: machine profile has no measured rigidity class', power,
    emitted: input.emitted ? 'captured moves; rpm resolved from operation/tool (no per-move spindle changes in CAM moves)' : 'n/a: emitted moves not persisted in WO-2899 baseline',
  } }
}

// Parameter units are route-specific: 3D adaptive is fraction D; 2D pocket is
// mm (PassParams); finishing raster is mm. Missing contact evidence remains unknown.
export function inputForRow(row: Pick<ScorecardRow, 'material' | 'opType' | 'settings' | 'status'>, tool: Tool, emitted?: readonly ToolpathMove[]): SettingsInput {
  const p = (row.settings?.params ?? {}) as Record<string, unknown>
  const override = row.settings?.feedrateOverride
  const recipe = tool.feedsAndSpeeds?.default
  const feed = override?.enabled ? override.feedRate : recipe?.feedRate ?? 300
  const rpm = override?.enabled ? override.rpm : recipe?.rpm
  const d = tool.diameter
  const rough3 = row.opType === 'adaptive_3d'
  const ap = rough3 ? positive(p.maxStepdown) : ['pocket_2d', 'adaptive_clearing_2d', 'contour_2d', 'face', 'bore', 'chamfer', 'engrave'].includes(row.opType) ? positive(row.settings?.passes.stepdown) : undefined
  const s = positive(p.stepover)
  const ae = rough3 ? (s === undefined ? undefined : s * d) : ['pocket_2d', 'adaptive_clearing_2d', 'face'].includes(row.opType) ? positive(row.settings?.passes.stepover) : undefined
  const strategy = rough3 && ap !== undefined ? (ap < d ? 'light-axial' : 'deep-axial') : row.opType
  const resolved = emitted ? resolveFeedrates(tool, override, profile.rapidRate) : undefined
  return { material: row.material ?? '', strategy, tool, rpm, feed, aeMm: ae, apMm: ap,
    machineId: profile.id, fallback: !override?.enabled && recipe?.feedRate == null,
    finishingStepMm: ['parallel_3d', 'steep_shallow_3d'].includes(row.opType) ? s : undefined,
    scallopHeightMm: positive(p.scallopHeight),
    ...((row.status && row.status !== 'ready') || (emitted && !emitted.length) ? { unavailable: `operation ${row.status ?? 'empty'}: no emitted path` } : {}),
    emitted: emitted?.map(move => ({ ...move, feed: move.type === 'rapid' ? move.feed : resolveMoveFeedrate(move, resolved!) })),
  }
}

// Reuse production engagement replay with the ACTUAL carried stock before this
// operation carves it. Slot fraction maps to ae/D only for cylindrical flat tools.
// The callback omits exactly-zero windows: recover their total length only when
// all measured moves have one feed; with varying feeds and missing attribution,
// remain n/a instead of assigning the wrong feed to air-over-cleared-stock.
export function replaySettings(input: SettingsInput, bounds: Box3, stock: ZDexelField, cutter: CutterSpec): EngagementSample[] | undefined {
  if (input.tool.type !== 'flat_end_mill' || !input.emitted?.length || !positive(input.rpm) ||
      !matchingRules(input).some(rule => rule.outputs.hex_mm)) return undefined
  const moves = toIrMoves(input.emitted)
  const samples: EngagementSample[] = []
  let incomplete = false
  const result = measurePathEngagement(moves, bounds, stock.cell, cutter, {
    startingStock: stock, capFraction: Number.MIN_VALUE,
    onOverCap(hit) {
      const feed = input.emitted![hit.moveIndex].feed
      if (!positive(feed)) incomplete = true
      samples.push({ lengthMm: hit.lengthMm, aeMm: hit.fraction * input.tool.diameter,
        feed: feed ?? 0, rpm: input.rpm! })
    },
  })
  if (incomplete) return undefined
  const missingLength = result.cuttingLengthMm - samples.reduce((sum, sample) => sum + sample.lengthMm, 0)
  if (missingLength > 1e-9) {
    const feeds = new Set(input.emitted.filter((_, index) => ['cut', 'finish', 'stepover'].includes(moves[index].role ?? '')).map(move => move.feed))
    const feed = [...feeds][0]
    if (feeds.size !== 1 || !positive(feed)) return undefined
    samples.push({ lengthMm: missingLength, aeMm: 0, feed: feed!, rpm: input.rpm! })
  }
  return samples.length ? samples : undefined
}
