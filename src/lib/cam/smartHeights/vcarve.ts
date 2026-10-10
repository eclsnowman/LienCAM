// Smart Height V2 for V-carve (WO-1174). Mirrors engrave.ts.
//
// The carve is measured from a physical datum surface. Material Start is the
// datum minus the start depth (carving inside an existing pocket, or an inlay
// plug that starts below its own top). Cutter End is Material Start minus the
// effective maximum depth: the operator's flat depth when set, otherwise the
// bit's own limit - the depth at which its full diameter is reached, or its
// flute length, whichever is shallower. The engine never cuts below Cutter
// End; every ridge point between the two planes is placed by the medial axis.

import type { HeightIntentV1, HeightParams, HeightPlaneName, HeightReference, Tool } from '../../../types'
import { toolTypeMeta } from '../../tool/toolMeta'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type AuthoredPlaneIntentV2,
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type ResolvedHeightPlanV2,
  type SmartHeightEvidenceNode,
  type SmartHeightRevisionStamp,
  type VCarveRegionFormulaIntent,
} from './types'

export type VCarveSmartHeightFlatDepth =
  | { kind: 'explicit'; depthMm: number }
  | { kind: 'tool_limit' }

export interface VCarvePathScope {
  geometryIds: string[]
  loopIds: string[]
}

export interface VCarveSmartHeightDraft {
  datumReference: Exclude<HeightReference, HeightPlaneName>
  datumOffsetMm: number
  startDepthMm: number
  flatDepth: VCarveSmartHeightFlatDepth
}

export interface VCarveSmartHeightIntentInput extends VCarveSmartHeightDraft {
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  scope: VCarvePathScope
}

export interface VCarveRemainingMaterialEvidence {
  artifactId: string
  materialTopMachineMm: number
  fingerprint: string
  representation: string
  compatible: boolean
}

export interface VCarveSmartHeightEvidenceInput {
  intent: OperationHeightIntentV2
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  tool: Tool
  scope: VCarvePathScope
  resolvedDatumMachineMm: number
  datumFingerprint: string
  referenceEvidence?: SmartHeightEvidenceNode[]
  remainingMaterial?: VCarveRemainingMaterialEvidence
}

export interface ResolvedVCarveSmartHeights {
  plan: ResolvedHeightPlanV2
  workerHeights: HeightParams
  snapshotIntent: HeightIntentV1
  formula: VCarveRegionFormulaIntent
  /** Effective maximum depth below Material Start (mm). */
  resolvedMaxDepthMm: number
  dependencyIds: string[]
}

export class VCarveSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`V-carve Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'VCarveSmartHeightError'
    this.refusal = refusal
  }
}

const policyOwner = { kind: 'operation_policy' as const }
const userOwner = { kind: 'user_override' as const }
const setupOwner = (setupId: string) => ({ kind: 'setup' as const, setupId })

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`)
  return value
}

function positive(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked <= 0) throw new Error(`${label} must be greater than zero.`)
  return checked
}

function nonNegative(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked < 0) throw new Error(`${label} cannot be negative.`)
  return checked
}

function validateDatumReference(reference: HeightReference): Exclude<HeightReference, HeightPlaneName> {
  if (['clearance', 'retract', 'feed', 'top', 'bottom'].includes(reference)) {
    throw new Error(`V-carve datum cannot reference derived '${reference}' height.`)
  }
  return reference as Exclude<HeightReference, HeightPlaneName>
}

function validateScope(scope: VCarvePathScope): VCarvePathScope {
  const geometryIds = scope.geometryIds.map(id => id.trim()).filter(Boolean)
  const loopIds = scope.loopIds.map(id => id.trim()).filter(Boolean)
  if (geometryIds.length === 0) throw new Error('V-carve Smart Height requires selected geometry.')
  if (loopIds.length === 0) throw new Error('V-carve Smart Height requires at least one closed outline.')
  if (new Set(geometryIds).size !== geometryIds.length) throw new Error('V-carve Smart Height contains duplicate geometry ids.')
  if (new Set(loopIds).size !== loopIds.length) throw new Error('V-carve Smart Height contains duplicate outline ids.')
  return { geometryIds, loopIds }
}

function sameScope(a: VCarvePathScope, b: VCarvePathScope): boolean {
  const sorted = (values: readonly string[]) => [...values].sort()
  return JSON.stringify(sorted(a.geometryIds)) === JSON.stringify(sorted(b.geometryIds)) &&
    JSON.stringify(sorted(a.loopIds)) === JSON.stringify(sorted(b.loopIds))
}

function validateFlatDepth(flat: VCarveSmartHeightFlatDepth): VCarveSmartHeightFlatDepth {
  return flat.kind === 'explicit'
    ? { kind: 'explicit', depthMm: positive(flat.depthMm, 'V-carve flat depth') }
    : { kind: 'tool_limit' }
}

function formulaFromIntent(intent: OperationHeightIntentV2): VCarveRegionFormulaIntent {
  const end = intent.machining.end.value
  if (end.kind !== 'geometry_tool_formula' || end.formula.kind !== 'vcarve_region') {
    throw new VCarveSmartHeightError({
      code: 'invalid_intent',
      message: 'V-carve authority does not contain a region-depth formula.',
    })
  }
  return end.formula
}

function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${smartHeightEvidenceFingerprint(value)}`
}

/** The bit's own deepest cut: full diameter reached, or flute length. */
export function vcarveToolLimitDepthMm(tool: Tool): number {
  const angle = tool.angleFromAxisDeg
  if (typeof angle !== 'number' || !Number.isFinite(angle) || angle <= 0 || angle >= 90) {
    throw new Error(`V-carve tool "${tool.name}" needs a tip angle between 0 and 90 degrees per side (a V-bit, engraving bit or chamfer mill).`)
  }
  const diameter = positive(tool.diameter, 'V-carve tool diameter')
  const tipDiameter = nonNegative(tool.tipDiameter ?? 0, 'V-carve tool tip diameter')
  if (tipDiameter >= diameter) throw new Error('V-carve tool tip diameter must be smaller than its diameter.')
  const tanHalf = Math.tan(angle * Math.PI / 180)
  const byDiameter = (diameter - tipDiameter) / (2 * tanHalf)
  const flute = Number.isFinite(tool.fluteLength) && tool.fluteLength > 0 ? tool.fluteLength : Infinity
  return Math.min(byDiameter, flute)
}

function resolvedMaxDepthForTool(formula: VCarveRegionFormulaIntent, tool: Tool): number {
  if (formula.flatDepth.kind === 'tool_limit') return vcarveToolLimitDepthMm(tool)
  const depth = positive(formula.flatDepth.depthMm, 'V-carve flat depth')
  // An explicit flat depth is also what the flat-clearing sibling carries:
  // that operation's tool is a plain end mill, whose only limit is its flute.
  // Whether the angle-based limit applies is a fact of the tool's declared
  // type (the same authority ToolLibraryModal/PropertiesPanel/ToolDiagram
  // read), never a residual angleFromAxisDeg field left over from an earlier
  // edit.
  const limit = toolTypeMeta(tool.type).hasAngle
    ? vcarveToolLimitDepthMm(tool)
    : (Number.isFinite(tool.fluteLength) && tool.fluteLength > 0 ? tool.fluteLength : Infinity)
  if (depth > limit + 1e-9) {
    throw new Error(
      `V-carve flat depth ${depth} mm is deeper than tool "${tool.name}" can cut (${Number(limit.toFixed(3))} mm at its full diameter or flute length).`,
    )
  }
  return depth
}

export function vcarveSmartHeightDraftFromIntent(intent: OperationHeightIntentV2): VCarveSmartHeightDraft {
  if (intent.policy.operationType !== 'vcarve') {
    throw new Error(`Cannot edit '${intent.policy.operationType}' as a V-carve policy.`)
  }
  if (intent.machining.start.value.kind !== 'geometry_tool_formula') {
    throw new Error('V-carve Smart Height Material Start is not formula-owned.')
  }
  const formula = formulaFromIntent(intent)
  const scope = intent.machining.scope.value
  if (scope.kind !== 'selected_paths') throw new Error('V-carve Smart Height has lost its selected outline scope.')
  validateScope(scope)
  const flatDepth = validateFlatDepth(formula.flatDepth)
  const expectedVariant = flatDepth.kind === 'explicit' ? 'flat_depth' : 'tool_limit'
  if (intent.policy.variant !== expectedVariant) throw new Error('V-carve Smart Height policy and depth formula disagree.')
  return {
    datumReference: validateDatumReference(formula.datumPlane.reference),
    datumOffsetMm: finite(formula.datumPlane.offsetMm, 'V-carve datum offset'),
    startDepthMm: nonNegative(formula.startDepthMm, 'V-carve start depth'),
    flatDepth,
  }
}

export function buildVCarveSmartHeightIntent(input: VCarveSmartHeightIntentInput): OperationHeightIntentV2 {
  const scope = validateScope(input.scope)
  const flatDepth = validateFlatDepth(input.flatDepth)
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']): AuthoredPlaneIntentV2 => ({
    reference: value.reference,
    offsetMm: finite(value.offset, 'V-carve safety offset'),
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  const formula: VCarveRegionFormulaIntent = {
    kind: 'vcarve_region',
    datumPlane: {
      reference: validateDatumReference(input.datumReference),
      offsetMm: finite(input.datumOffsetMm, 'V-carve datum offset'),
      owner: userOwner,
    },
    startDepthMm: nonNegative(input.startDepthMm, 'V-carve start depth'),
    flatDepth,
  }
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: {
      operationType: 'vcarve',
      variant: flatDepth.kind === 'explicit' ? 'flat_depth' : 'tool_limit',
    },
    safety: {
      clearance: safetyPlane(input.safetyIntent.clearance),
      retract: safetyPlane(input.safetyIntent.retract),
      feed: safetyPlane(input.safetyIntent.feed),
    },
    machining: {
      start: { owner: policyOwner, value: { kind: 'geometry_tool_formula' } },
      end: { owner: policyOwner, value: { kind: 'geometry_tool_formula', formula } },
      scope: { owner: policyOwner, value: { kind: 'selected_paths', ...scope, includeOpen: false, includeClosed: true } },
    },
  }
}

/** Re-author an intent with a patched draft (Properties panel edits), keeping
 *  the safety planes and the outline scope of the persisted intent. */
export function rebuildVCarveSmartHeightIntent(input: {
  intent: OperationHeightIntentV2
  setupId: string
  patch?: Partial<VCarveSmartHeightDraft>
}): OperationHeightIntentV2 {
  const current = vcarveSmartHeightDraftFromIntent(input.intent)
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'selected_paths') throw new Error('V-carve Smart Height outline scope is missing.')
  const safety = (plane: AuthoredPlaneIntentV2): HeightIntentV1['clearance'] => ({
    reference: plane.reference,
    offset: plane.offsetMm,
    provenance: plane.owner.kind === 'user_override' ? 'user' : 'inferred',
  })
  const rebuilt = buildVCarveSmartHeightIntent({
    setupId: input.setupId,
    safetyIntent: {
      clearance: safety(input.intent.safety.clearance),
      retract: safety(input.intent.safety.retract),
      feed: safety(input.intent.safety.feed),
    },
    ...current,
    ...input.patch,
    scope: { geometryIds: scope.geometryIds, loopIds: scope.loopIds },
  })
  return input.intent.planeOverrides
    ? { ...rebuilt, planeOverrides: input.intent.planeOverrides }
    : rebuilt
}

export function buildVCarveSmartHeightEvidenceContext(input: VCarveSmartHeightEvidenceInput): HeightEvidenceContext {
  if (input.intent.policy.operationType !== 'vcarve') throw new Error('V-carve evidence requires V-carve intent.')
  const formula = formulaFromIntent(input.intent)
  vcarveSmartHeightDraftFromIntent(input.intent)
  const authoredScope = input.intent.machining.scope.value
  if (authoredScope.kind !== 'selected_paths') throw new Error('V-carve evidence requires selected outline scope.')
  const currentScope = validateScope(input.scope)
  if (!sameScope(authoredScope, currentScope)) {
    throw new VCarveSmartHeightError({
      code: 'stale_dependency',
      message: 'The selected V-carve outlines changed. Re-open the operation and confirm the replacement outlines.',
    })
  }
  const datum = finite(input.resolvedDatumMachineMm, 'V-carve resolved datum')
  const wcsOrigin = finite(input.wcsOriginMachineMm, 'V-carve WCS origin')
  const toolId = input.tool.id.trim()
  if (!toolId) throw new Error('V-carve tool id cannot be blank.')
  if (!input.datumFingerprint.trim()) throw new Error('V-carve datum fingerprint cannot be blank.')

  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const datumId = `selected-plane:${input.operationId}`
  const toolIdNode = `tool:${toolId}`

  let effectiveDatum = datum
  const startDependencyNodeIds = [datumId, toolIdNode]
  const remainingMaterialNodes: SmartHeightEvidenceNode[] = []

  if (input.remainingMaterial?.compatible) {
    const remaining = input.remainingMaterial
    const artifactId = remaining.artifactId.trim()
    if (!artifactId) throw new Error('V-carve remaining material artifact id cannot be blank.')
    const materialId = `remaining-material:${artifactId}`
    const remainingTop = finite(remaining.materialTopMachineMm, 'V-carve remaining material Top')
    remainingMaterialNodes.push(
      {
        id: materialId,
        kind: 'remaining_material',
        role: 'material_artifact',
        entityId: artifactId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: remaining.fingerprint,
      },
      {
        id: `${materialId}:top`,
        kind: 'remaining_material',
        role: 'material_top',
        entityId: artifactId,
        dependencyNodeIds: [materialId],
        dependencyFingerprint: remaining.fingerprint,
        scalar: {
          frame: 'machine',
          valueMm: remainingTop,
        },
      },
    )
    if (remainingTop < effectiveDatum) {
      effectiveDatum = remainingTop
      startDependencyNodeIds.push(`${materialId}:top`)
    }
  }

  const maxDepthMm = resolvedMaxDepthForTool(formula, input.tool)
  const materialStart = effectiveDatum - formula.startDepthMm
  const cutterEnd = materialStart - maxDepthMm
  const formulaFingerprint = fingerprint(input.revision.operationRevision, {
    formula,
    datumMachineMm: effectiveDatum,
    materialStartMachineMm: materialStart,
    cutterEndMachineMm: cutterEnd,
    tool: {
      id: toolId,
      type: input.tool.type,
      diameter: input.tool.diameter,
      tipDiameter: input.tool.tipDiameter,
      angleFromAxisDeg: input.tool.angleFromAxisDeg,
      fluteLength: input.tool.fluteLength,
    },
  })
  const nodes: SmartHeightEvidenceNode[] = [
    {
      id: wcsId,
      kind: 'setup_wcs',
      role: 'wcs_origin',
      entityId: input.operationId,
      dependencyNodeIds: [],
      dependencyFingerprint: fingerprint(input.revision.setupRevision, wcsOrigin),
      scalar: { frame: 'machine', valueMm: wcsOrigin },
    },
    {
      id: scopeId,
      kind: 'operation_scope',
      role: 'scope',
      entityId: input.operationId,
      dependencyNodeIds: [wcsId],
      dependencyFingerprint: fingerprint(input.revision.operationRevision, authoredScope),
    },
    ...(input.referenceEvidence ?? []),
    ...remainingMaterialNodes,
    {
      id: datumId,
      kind: 'selected_plane',
      role: 'selected_plane',
      entityId: input.operationId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: fingerprint(input.datumFingerprint, { datumPlane: formula.datumPlane, datumMachineMm: datum }),
      scalar: { frame: 'machine', valueMm: datum },
    },
    {
      id: toolIdNode,
      kind: 'tool_geometry',
      role: 'tool',
      entityId: toolId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: fingerprint(toolId, input.tool),
    },
    {
      id: `vcarve-formula:${input.operationId}:start`,
      kind: 'strategy_allowance',
      role: 'formula_material_start',
      entityId: input.operationId,
      dependencyNodeIds: startDependencyNodeIds,
      dependencyFingerprint: formulaFingerprint,
      scalar: { frame: 'machine', valueMm: materialStart },
    },
    {
      id: `vcarve-formula:${input.operationId}:end`,
      kind: 'strategy_allowance',
      role: 'formula_cutter_end',
      entityId: input.operationId,
      dependencyNodeIds: startDependencyNodeIds,
      dependencyFingerprint: formulaFingerprint,
      scalar: { frame: 'machine', valueMm: cutterEnd },
    },
  ]
  return {
    revision: input.revision,
    operationType: 'vcarve',
    wcsOriginMachineMm: wcsOrigin,
    evidence: nodes,
  }
}

export function resolveVCarveSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
}): ResolvedVCarveSmartHeights {
  if (input.intent.policy.operationType !== 'vcarve' || input.evidence.operationType !== 'vcarve') {
    throw new VCarveSmartHeightError({
      code: 'policy_mismatch',
      message: 'V-carve Smart Height received non-V-carve intent or evidence.',
    })
  }
  const formula = formulaFromIntent(input.intent)
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new VCarveSmartHeightError(result.refusal)
  const plan = result.plan
  const feed = plan.safety.feed
  const cutterEnd = plan.machining.cutterCenterEnd
  if (!feed || !cutterEnd) {
    throw new VCarveSmartHeightError({
      code: 'invalid_evidence',
      message: 'V-carve Smart Height did not resolve Feed and cutter endpoints.',
    })
  }
  const resolvedMaxDepthMm = plan.machining.materialStart.wcsMm - cutterEnd.wcsMm
  const inferred = (offset: number) => ({ reference: 'wcs_plane' as const, offset, provenance: 'inferred' as const })
  const snapshotIntent: HeightIntentV1 = {
    version: 1,
    clearance: inferred(plan.safety.clearance.wcsMm),
    retract: inferred(plan.safety.retract.wcsMm),
    feed: inferred(feed.wcsMm),
    top: inferred(plan.machining.materialStart.wcsMm),
    bottom: inferred(cutterEnd.wcsMm),
  }
  return {
    plan,
    formula,
    resolvedMaxDepthMm,
    snapshotIntent,
    workerHeights: {
      clearanceHeight: plan.safety.clearance.wcsMm,
      clearanceHeightMode: 'absolute',
      retractHeight: plan.safety.retract.wcsMm,
      feedHeight: feed.wcsMm,
      topHeight: plan.machining.materialStart.wcsMm,
      topHeightMode: 'absolute',
      bottomHeight: cutterEnd.wcsMm,
      bottomHeightMode: 'absolute',
      heightIntent: snapshotIntent,
    },
    dependencyIds: plan.evidenceGraph.map(node => node.id),
  }
}
