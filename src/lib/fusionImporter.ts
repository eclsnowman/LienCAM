import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
import { unzipSync, strFromU8 } from 'fflate'
import type { Tool, ToolType, ToolCutHand, ToolMaterial, FeedsAndSpeeds, ToolHolder, HolderSegment } from '../types'
import {
  toCanonicalMm,
  resolveToolType,
  validateToolGeometry,
  validateHolderSegment,
  type RecordDiagnostic,
} from './tool/toolValidation'

/**
 * Decode the raw bytes of an imported tool-library file into parsed JSON.
 *
 * A `.tools` file is a ZIP archive wrapping a single `tools.json`
 * entry (it starts with the "PK" local-file-header magic). A plain `.json`
 * export is UTF-8 JSON. This detects the ZIP by magic bytes, extracts the
 * `tools.json` (or the first `.json`) entry, and returns the parsed object.
 *
 * Throws (never returns a silent empty result, per ADR-0003) when the archive
 * has no usable JSON entry or the JSON is malformed — the caller surfaces it.
 */
export function decodeToolLibraryFile(bytes: Uint8Array): unknown {
  let text: string
  // ZIP local-file-header magic: 0x50 0x4B 0x03 0x04 ("PK\x03\x04").
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const entries = unzipSync(bytes)
    const name =
      Object.keys(entries).find((n) => n.toLowerCase().endsWith('tools.json')) ??
      Object.keys(entries).find((n) => n.toLowerCase().endsWith('.json'))
    if (!name) {
      throw new Error(operatorText('fusionImporter1'))
    }
    text = strFromU8(entries[name])
  } else {
    text = strFromU8(bytes)
  }
  return JSON.parse(text)
}

type FusionPreset = {
  name?: string  // preset label, when the wrapped format names a preset
  n?: number
  v_f?: number
  v_f_plunge?: number
  v_f_ramp?: number
  v_f_leadIn?: number
  v_f_leadOut?: number
  'ramp-angle'?: number
  'tool-coolant'?: string
  f_z?: number   // The wrapped format uses `f_z`, not fz
  fz?: number    // fallback
  v_c?: number   // The wrapped format uses `v_c` for surface speed (m/min)
  vc?: number    // fallback
}

type FusionGeometry = {
  DC?: number
  SFDM?: number
  LCF?: number
  OAL?: number
  LB?: number
  'shoulder-length'?: number
  NOF?: number
  RE?: number
  TA?: number
  SIG?: number
}

// A wrapped-format holder block: a revolved segment stack from the tool side upward.
// (kebab-case keys, e.g. lower-diameter; mapped to camelCase HolderSegment.)
type FusionHolderSegment = {
  height?: number
  'lower-diameter'?: number
  'upper-diameter'?: number
}
export type FusionHolder = {
  type?: string
  name?: string
  vendor?: string
  'product-id'?: string
  description?: string
  guid?: string
  gaugeLength?: number
  segments?: FusionHolderSegment[]
}

type FusionTool = {
  description?: string
  type?: string
  unit?: string
  BMC?: string
  geometry?: FusionGeometry
  'start-values'?: { presets?: FusionPreset[] }
  vendor?: string
  'product-id'?: string
  'post-process'?: { number?: number; 'length-offset'?: number; 'diameter-offset'?: number }
  holder?: FusionHolder
  // NOTE: a wrapped-format `shaft` block is the tool's OWN shank (not the holder) and is
  // OUT OF SCOPE here — we ignore it (the shank lives on Tool.shankDiameter).
}

const TYPE_MAP: Record<string, ToolType> = {
  'flat end mill':       'flat_end_mill',
  'ball end mill':       'ball_end_mill',
  'bull nose end mill':  'bull_nose',
  'v-bit':               'v_bit',
  'chamfer mill':        'chamfer_mill',
  'tapered mill':        'tapered_endmill',
  'tapered end mill':    'tapered_endmill',
  'counter sink':        'countersink',
  'countersink':         'countersink',
  'center drill':        'center_drill',
  'drill':               'drill',
  'spot drill':          'spot_drill',
  'thread mill':         'thread_mill',
  'face mill':           'face_mill',
  'tap right hand':      'tap',
  'tap left hand':       'tap',
  'boring bar':          'boring_bar',
  'probe':               'probe',
}

const MATERIAL_MAP: Record<string, ToolMaterial> = {
  carbide:  'carbide',
  hss:      'hss',
  'hss-co': 'cobalt',
  cobalt:   'cobalt',
  ceramic:  'ceramic',
  diamond:  'diamond_coated',
}

// Fusion declares the cutter hand inside the raw type string ("tap left hand"
// vs "tap right hand"); TYPE_MAP collapses both to ToolType 'tap', so the hand
// must be read off the raw string before that happens. A tool with no declared
// hand keeps the standard right-hand default.
function fusionCutHand(rawType: string | undefined): ToolCutHand {
  return (rawType?.toLowerCase() ?? '').includes('left hand') ? 'left' : 'right'
}

// The wrapped format stores tool angles two different ways depending on the tool type:
//   - INCLUDED point-angle types (drill, spot/center drill, countersink, v-bit)
//     store the FULL included angle in geometry.SIG (TA sometimes mirrors it).
//     Canonical angleFromAxisDeg = full / 2.
//   - FROM-AXIS types (chamfer mill, tapered mill) store the per-side angle
//     already measured from the tool axis in geometry.TA. Use it as-is.
// Angles are unitless degrees -> no unit conversion. Returns undefined when no
// usable angle is present (e.g. flat/ball/bull end mills with SIG=0/TA=0).
const INCLUDED_ANGLE_TYPES: ReadonlySet<ToolType> = new Set([
  'drill', 'spot_drill', 'center_drill', 'countersink', 'v_bit',
])
const FROM_AXIS_ANGLE_TYPES: ReadonlySet<ToolType> = new Set([
  'chamfer_mill', 'tapered_endmill',
])

function fusionAngleFromAxis(type: ToolType, geo: FusionGeometry): number | undefined {
  const sig = typeof geo.SIG === 'number' ? geo.SIG : 0
  const ta  = typeof geo.TA  === 'number' ? geo.TA  : 0
  if (INCLUDED_ANGLE_TYPES.has(type)) {
    const full = sig || ta
    return full > 0 ? full / 2 : undefined
  }
  if (FROM_AXIS_ANGLE_TYPES.has(type)) {
    const fromAxis = ta || sig
    return fromAxis > 0 ? fromAxis : undefined
  }
  return undefined
}

// Key a preset by its name when the wrapped format gives one, else a stable
// 1-based fallback. `default` is reserved separately for the first preset's
// values, so every existing single-preset import keeps reading unchanged.
function presetKey(p: FusionPreset, index: number): string {
  const name = p.name?.trim()
  return name && name.length > 0 ? name : `preset-${index + 1}`
}

// Disambiguate a preset key against keys already claimed in this import (including the
// reserved 'default' alias) so a repeated or reserved preset name never overwrites an
// earlier entry - every preset keeps its own slot.
function uniquePresetKey(baseKey: string, used: Set<string>): string {
  if (!used.has(baseKey)) return baseKey
  let n = 2
  while (used.has(`${baseKey} (${n})`)) n++
  return `${baseKey} (${n})`
}

function mapPreset(p: FusionPreset): FeedsAndSpeeds {
  const coolantRaw = p['tool-coolant'] ?? 'disabled'
  const coolant: FeedsAndSpeeds['coolant'] =
    coolantRaw === 'flood' ? 'flood'
    : coolantRaw === 'mist' ? 'mist'
    : coolantRaw === 'air' ? 'air'
    : 'none'
  return {
    rpm:             p.n            ?? 0,
    feedRate:        p.v_f          ?? 0,
    plungeRate:      p.v_f_plunge   ?? p.v_f ?? 0,
    depthOfCut:      0,
    stepover:        0,
    rampFeedrate:    p.v_f_ramp,
    leadInFeedrate:  p.v_f_leadIn,
    leadOutFeedrate: p.v_f_leadOut,
    rampAngle:       p['ramp-angle'],
    coolant,
    feedPerTooth:    p.f_z ?? p.fz,   // The wrapped format uses `f_z`
    surfaceSpeed:    p.v_c ?? p.vc,   // The wrapped format uses `v_c`
  }
}

export interface HolderParseResult {
  holder: ToolHolder | undefined
  /** Segments dropped by validateHolderSegment (BUG-519): a missing/string/null
   *  dimension is no longer silently coerced to 0, and a zero/negative dimension
   *  is rejected rather than registered. Valid segments still import. */
  rejectedSegments: RecordDiagnostic[]
}

// Build a ToolHolder from a wrapped-format `holder` block, mapping kebab-case keys to
// camelCase. Returns holder: undefined when the block is absent, has no segments, or
// every segment failed validation. Exported so the internal-format import branch can
// rehydrate a `holder` block re-embedded by serializeHolderForFusion the same way the
// fusion branch does.
export function parseFusionHolder(holder: FusionHolder | undefined, unit: string): HolderParseResult {
  if (!holder || !Array.isArray(holder.segments) || holder.segments.length === 0) {
    return { holder: undefined, rejectedSegments: [] }
  }
  const segments: HolderSegment[] = []
  const rejectedSegments: RecordDiagnostic[] = []
  holder.segments.forEach((s, i) => {
    const rawHeight = typeof s.height === 'number' ? s.height : undefined
    const rawLower  = typeof s['lower-diameter'] === 'number' ? s['lower-diameter'] : undefined
    const rawUpper  = typeof s['upper-diameter'] === 'number' ? s['upper-diameter'] : undefined
    const segment: HolderSegment = {
      height:        rawHeight !== undefined ? toCanonicalMm(rawHeight, unit) : NaN,
      lowerDiameter: rawLower  !== undefined ? toCanonicalMm(rawLower,  unit) : NaN,
      upperDiameter: rawUpper  !== undefined ? toCanonicalMm(rawUpper,  unit) : NaN,
    }
    const check = validateHolderSegment(segment)
    if (check.ok) segments.push(segment)
    else rejectedSegments.push({ label: operatorText('fusionImporter2', { value1: String(i + 1) }), reason: check.reason })
  })
  if (segments.length === 0) return { holder: undefined, rejectedSegments }
  const name =
    holder.name || holder.description || holder['product-id'] || holder.vendor || operatorText('fusionImporter3')
  return {
    holder: {
      id:          holder.guid && holder.guid.length > 0 ? holder.guid : crypto.randomUUID(),
      name,
      vendor:      holder.vendor,
      productId:   holder['product-id'],
      description: holder.description,
      gaugeLength: typeof holder.gaugeLength === 'number' ? toCanonicalMm(holder.gaugeLength, unit) : undefined,
      segments,
    },
    rejectedSegments,
  }
}

/**
 * Parse a wrapped tool library. Returns the tools, any embedded holders, and a
 * flat diagnostics list (one entry per rejected record/segment or unrecognized
 * cutter type) — the caller builds ONE console summary from it rather than a
 * bare success count (BUG-518's "swallowed rejects" extended to this path).
 * Holders are deduped by id (the external-format GUID) across the whole import, and each
 * tool that carries a holder gets its holderId linked to the deduped holder.
 */
export function importFusionTools(
  json: unknown,
): { tools: Tool[]; holders: ToolHolder[]; diagnostics: RecordDiagnostic[] } {
  // The wrapped format wraps the tool array in { "data": [...] }
  const unwrapped =
    Array.isArray(json) ? json
    : (json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).data))
      ? (json as Record<string, unknown>).data as unknown[]
      : [json]

  const list = unwrapped

  // Deduped holders accumulated across the import (key = holder id / guid).
  const holdersById = new Map<string, ToolHolder>()
  const diagnostics: RecordDiagnostic[] = []

  const tools = list
    .filter((item): item is FusionTool => typeof item === 'object' && item !== null)
    .map((ft, index): Tool | null => {
      const label = ft.description || ft['product-id'] || operatorText('fusionImporter4', { value1: String(index + 1) })
      const unit = ft.unit ?? 'millimeters'
      const geo = ft.geometry ?? {}

      // Normalize once (BUG-509): every fallback below is derived from the RAW
      // (pre-conversion) value of an earlier field, never an already-converted
      // one — the whole chain converts to mm exactly once, at the end.
      const diameterRaw      = geo.DC ?? 6
      const shankDiameterRaw = geo.SFDM ?? diameterRaw
      const fluteLengthRaw   = geo.LCF ?? diameterRaw * 2
      const overallLengthRaw = geo.OAL ?? fluteLengthRaw * 2.5

      const diameter          = toCanonicalMm(diameterRaw, unit)
      const shankDiameter     = toCanonicalMm(shankDiameterRaw, unit)
      const fluteLength       = toCanonicalMm(fluteLengthRaw, unit)
      const overallLength     = toCanonicalMm(overallLengthRaw, unit)
      const shoulderLength    = geo['shoulder-length'] !== undefined ? toCanonicalMm(geo['shoulder-length'], unit) : undefined
      const lengthBelowHolder = geo.LB !== undefined ? toCanonicalMm(geo.LB, unit) : undefined
      const cornerRadius      = geo.RE !== undefined ? toCanonicalMm(geo.RE, unit) : undefined

      const geometryCheck = validateToolGeometry({ diameter, shankDiameter, fluteLength, overallLength, lengthBelowHolder })
      if (!geometryCheck.ok) {
        diagnostics.push({ label, reason: geometryCheck.reason })
        return null
      }

      // BUG-510: an unrecognized cutter type is NOT a reject — import it under a
      // safe fallback and report the substitution once, rather than silently
      // promoting it to full fallback-type machining capability.
      const { type: toolType, unknownDeclaredType } = resolveToolType(ft.type, TYPE_MAP, 'flat_end_mill')
      if (unknownDeclaredType) {
        diagnostics.push({
          label,
          reason: operatorText('fusionImporter5', { value1: String(unknownDeclaredType), value2: String(toolType) }),
        })
      }
      const material: ToolMaterial = MATERIAL_MAP[ft.BMC?.toLowerCase() ?? ''] ?? 'carbide'

      const presets = ft['start-values']?.presets ?? []
      let feedsAndSpeeds: Record<string, FeedsAndSpeeds>
      if (presets.length === 0) {
        feedsAndSpeeds = {
          default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: diameter * 0.25, stepover: diameter * 0.5 },
        }
      } else if (presets.length === 1) {
        // Single preset: keep the existing shape exactly (one entry, no key churn).
        feedsAndSpeeds = { default: mapPreset(presets[0]) }
      } else {
        // Multiple named presets: give each its own entry, and additionally
        // alias 'default' to the first preset so existing readers are unaffected.
        feedsAndSpeeds = { default: mapPreset(presets[0]) }
        const usedKeys = new Set<string>(['default'])
        presets.forEach((preset, i) => {
          const key = uniquePresetKey(presetKey(preset, i), usedKeys)
          usedKeys.add(key)
          feedsAndSpeeds[key] = mapPreset(preset)
        })
      }

      const pp = ft['post-process'] ?? {}

      // Extract + dedupe the embedded holder (if any) and link the tool to it.
      const { holder: parsedHolder, rejectedSegments } = parseFusionHolder(ft.holder, unit)
      rejectedSegments.forEach((r) => diagnostics.push({ label: operatorText('fusionImporter6', { value1: String(label), value2: String(r.label) }), reason: r.reason }))
      let holderId: string | undefined
      if (parsedHolder) {
        const existing = holdersById.get(parsedHolder.id)
        if (existing) holderId = existing.id
        else { holdersById.set(parsedHolder.id, parsedHolder); holderId = parsedHolder.id }
      }

      return {
        id:               crypto.randomUUID(),
        name:             ft.description ?? operatorText('fusionImporter7', { value1: String(toolType.replace(/_/g,' ')), value2: String(diameter.toFixed(1)) }),
        type:             toolType,
        diameter,
        shankDiameter,
        fluteLength,
        overallLength,
        shoulderLength,
        lengthBelowHolder,
        numberOfFlutes:   geo.NOF ?? 2,
        cornerRadius,
        angleFromAxisDeg: fusionAngleFromAxis(toolType, geo),
        material,
        coating:          'none',
        vendor:           ft.vendor,
        productId:        ft['product-id'],
        toolNumber:       pp.number,
        cutHand:          fusionCutHand(ft.type),
        holderId,
        notes:            '',
        declaredTypeRaw:  unknownDeclaredType,
        feedsAndSpeeds,
      }
    })
    .filter((t): t is Tool => t !== null)

  return { tools, holders: Array.from(holdersById.values()), diagnostics }
}

/**
 * Serialize a ToolHolder back into a wrapped-format-compatible `holder` block (kebab-case
 * keys: lower-diameter / upper-diameter / product-id / gaugeLength) so an exported
 * library round-trips with the wrapped format. Used by the export path to re-embed holders.
 */
export function serializeHolderForFusion(holder: ToolHolder): Record<string, unknown> {
  return {
    type:          'holder',
    guid:          holder.id,
    name:          holder.name,
    vendor:        holder.vendor,
    'product-id':  holder.productId,
    description:   holder.description,
    gaugeLength:   holder.gaugeLength,
    segments:      holder.segments.map((s) => ({
      height:           s.height,
      'lower-diameter': s.lowerDiameter,
      'upper-diameter': s.upperDiameter,
    })),
  }
}
