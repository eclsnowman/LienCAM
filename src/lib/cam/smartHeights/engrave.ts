import type { HeightIntentV1, HeightParams, HeightPlaneName, HeightReference, Tool } from '../../../types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type AuthoredPlaneIntentV2,
  type EngravePathFormulaIntent,
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type ResolvedHeightPlanV2,
  type SmartHeightEvidenceNode,
  type SmartHeightRevisionStamp,
} from './types'

export type EngraveSmartHeightDepth =
  | { kind: 'explicit'; depthMm: number }
  | { kind: 'line_width'; targetLineWidthMm: number }

export interface EngravePathScope {
  geometryIds: string[]
  loopIds: string[]
  includeOpen: boolean
  includeClosed: boolean
}

export interface EngraveSmartHeightDraft {
  datumReference: Exclude<HeightReference, HeightPlaneName>
  datumOffsetMm: number
  axialOffsetMm: number
  depth: EngraveSmartHeightDepth
  /** WO-1969: ride the part's top surface at the depth below it, instead of
   *  cutting at one fixed Z below the datum. */
  followSurface?: boolean
}

export interface EngraveSmartHeightIntentInput extends EngraveSmartHeightDraft {
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  scope: EngravePathScope
}

export interface EngraveRemainingMaterialEvidence {
  artifactId: string
  materialTopMachineMm: number
  fingerprint: string
  representation: string
  compatible: boolean
}

export interface EngraveSmartHeightEvidenceInput {
  intent: OperationHeightIntentV2
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  tool: Tool
  scope: EngravePathScope
  resolvedDatumMachineMm: number
  datumFingerprint: string
  referenceEvidence?: SmartHeightEvidenceNode[]
  remainingMaterial?: EngraveRemainingMaterialEvidence
  /** WO-1969: the part's top surface sampled under the paths. Required for a
   *  surface-following policy, where it replaces the datum plane. */
  surface?: EngraveSurfaceEvidence
}

export interface EngraveSurfaceEvidence {
  artifactId: string
  fingerprint: string
  /** Lowest and highest surface point under the paths, machine Z. */
  minMachineMm: number
  maxMachineMm: number
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface ResolvedEngraveSmartHeights {
  plan: ResolvedHeightPlanV2
  workerHeights: HeightParams
  snapshotIntent: HeightIntentV1
  formula: EngravePathFormulaIntent
  resolvedDepthMm: number
  dependencyIds: string[]
}

export class EngraveSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Engrave Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'EngraveSmartHeightError'
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

function validateDatumReference(
  reference: HeightReference,
): Exclude<HeightReference, HeightPlaneName> {
  if (['clearance', 'retract', 'feed', 'top', 'bottom'].includes(reference)) {
    throw new Error(`Engrave datum cannot reference derived '${reference}' height.`)
  }
  return reference as Exclude<HeightReference, HeightPlaneName>
}

function validateScope(scope: EngravePathScope): EngravePathScope {
  const geometryIds = scope.geometryIds.map(id => id.trim()).filter(Boolean)
  const loopIds = scope.loopIds.map(id => id.trim()).filter(Boolean)
  if (geometryIds.length === 0) throw new Error('Engrave Smart Height requires selected geometry.')
  if (loopIds.length === 0) throw new Error('Engrave Smart Height requires at least one selected path.')
  if (!scope.includeOpen && !scope.includeClosed) {
    throw new Error('Engrave Smart Height must include open paths, closed paths, or both.')
  }
  if (new Set(geometryIds).size !== geometryIds.length) {
    throw new Error('Engrave Smart Height contains duplicate geometry ids.')
  }
  if (new Set(loopIds).size !== loopIds.length) {
    throw new Error('Engrave Smart Height contains duplicate path ids.')
  }
  return { ...scope, geometryIds, loopIds }
}

function sameScope(a: EngravePathScope, b: EngravePathScope): boolean {
  const sorted = (values: readonly string[]) => [...values].sort()
  return a.includeOpen === b.includeOpen &&
    a.includeClosed === b.includeClosed &&
    JSON.stringify(sorted(a.geometryIds)) === JSON.stringify(sorted(b.geometryIds)) &&
    JSON.stringify(sorted(a.loopIds)) === JSON.stringify(sorted(b.loopIds))
}

function validateDepth(depth: EngraveSmartHeightDepth): EngraveSmartHeightDepth {
  return depth.kind === 'explicit'
    ? { kind: 'explicit', depthMm: positive(depth.depthMm, 'Engrave depth') }
    : { kind: 'line_width', targetLineWidthMm: positive(depth.targetLineWidthMm, 'Engrave line width') }
}

function formulaFromIntent(intent: OperationHeightIntentV2): EngravePathFormulaIntent {
  const end = intent.machining.end.value
  if (end.kind !== 'geometry_tool_formula' || end.formula.kind !== 'engrave_path') {
    throw new EngraveSmartHeightError({
      code: 'invalid_intent',
      message: 'Engrave authority does not contain a path-depth formula.',
    })
  }
  return end.formula
}

function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${smartHeightEvidenceFingerprint(value)}`
}

/** The cut depth an Engrave formula asks of this tool, mm: the explicit depth,
 *  or the depth that opens the requested line width. */
export function engraveFormulaDepthMm(formula: EngravePathFormulaIntent, tool: Tool): number {
  return resolvedDepthForTool(formula, tool)
}

function resolvedDepthForTool(formula: EngravePathFormulaIntent, tool: Tool): number {
  const diameter = positive(tool.diameter, 'Engrave tool diameter')
  const fluteLength = positive(tool.fluteLength, 'Engrave tool flute length')
  if (formula.depth.kind === 'explicit') {
    const depth = positive(formula.depth.depthMm, 'Engrave depth')
    if (depth > fluteLength + 1e-9) {
      throw new Error(`Engrave depth ${depth} mm exceeds the tool flute length ${fluteLength} mm.`)
    }
    return depth
  }

  const angle = finite(tool.angleFromAxisDeg ?? NaN, 'Engrave tool half-angle')
  if (angle <= 0 || angle >= 90) {
    throw new Error('Engrave tool half-angle must be greater than zero and less than 90 degrees.')
  }
  const tipDiameter = finite(tool.tipDiameter ?? 0, 'Engrave tool tip diameter')
  if (tipDiameter < 0 || tipDiameter >= diameter) {
    throw new Error('Engrave tool tip diameter must be non-negative and smaller than its diameter.')
  }
  const tanHalf = Math.tan(angle * Math.PI / 180)
  const maximumWidth = Math.min(diameter, tipDiameter + 2 * fluteLength * tanHalf)
  const width = positive(formula.depth.targetLineWidthMm, 'Engrave line width')
  if (width <= tipDiameter + 1e-9) {
    throw new Error(`Engrave line width must be greater than the tool tip-flat diameter ${tipDiameter} mm.`)
  }
  if (width > maximumWidth + 1e-9) {
    throw new Error(
      `Engrave line width ${width} mm exceeds the tool's usable profile width ${Number(maximumWidth.toFixed(6))} mm.`,
    )
  }
  return (width - tipDiameter) / (2 * tanHalf)
}

export function engraveSmartHeightDraftFromIntent(
  intent: OperationHeightIntentV2,
): EngraveSmartHeightDraft {
  if (intent.policy.operationType !== 'engrave') {
    throw new Error(`Cannot edit '${intent.policy.operationType}' as an Engrave policy.`)
  }
  if (intent.machining.start.value.kind !== 'geometry_tool_formula') {
    throw new Error('Engrave Smart Height Material Start is not formula-owned.')
  }
  const formula = formulaFromIntent(intent)
  const scope = intent.machining.scope.value
  if (scope.kind !== 'selected_paths') {
    throw new Error('Engrave Smart Height has lost its selected path scope.')
  }
  validateScope(scope)
  const depth = validateDepth(formula.depth)
  const followSurface = intent.policy.variant === 'surface_following'
  const expectedVariant = depth.kind === 'explicit' ? 'explicit_depth' : 'width_derived'
  if (!followSurface && intent.policy.variant !== expectedVariant) {
    throw new Error('Engrave Smart Height policy and depth formula disagree.')
  }
  return {
    datumReference: validateDatumReference(formula.datumPlane.reference),
    datumOffsetMm: finite(formula.datumPlane.offsetMm, 'Engrave datum offset'),
    axialOffsetMm: finite(formula.axialOffsetMm, 'Engrave axial offset'),
    depth,
    ...(followSurface ? { followSurface: true } : {}),
  }
}

export function buildEngraveSmartHeightIntent(
  input: EngraveSmartHeightIntentInput,
): OperationHeightIntentV2 {
  const scope = validateScope(input.scope)
  const depth = validateDepth(input.depth)
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']): AuthoredPlaneIntentV2 => ({
    reference: value.reference,
    offsetMm: finite(value.offset, 'Engrave safety offset'),
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  const formula: EngravePathFormulaIntent = {
    kind: 'engrave_path',
    datumPlane: {
      reference: validateDatumReference(input.datumReference),
      offsetMm: finite(input.datumOffsetMm, 'Engrave datum offset'),
      owner: userOwner,
    },
    axialOffsetMm: finite(input.axialOffsetMm, 'Engrave axial offset'),
    depth,
  }
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: {
      operationType: 'engrave',
      variant: input.followSurface
        ? 'surface_following'
        : depth.kind === 'explicit' ? 'explicit_depth' : 'width_derived',
    },
    safety: {
      clearance: safetyPlane(input.safetyIntent.clearance),
      retract: safetyPlane(input.safetyIntent.retract),
      feed: safetyPlane(input.safetyIntent.feed),
    },
    machining: {
      start: { owner: policyOwner, value: { kind: 'geometry_tool_formula' } },
      end: { owner: policyOwner, value: { kind: 'geometry_tool_formula', formula } },
      scope: { owner: policyOwner, value: { kind: 'selected_paths', ...scope } },
    },
  }
}

export function rebuildEngraveSmartHeightIntent(input: {
  intent: OperationHeightIntentV2
  setupId: string
  safetyIntent?: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  patch?: Partial<EngraveSmartHeightDraft>
}): OperationHeightIntentV2 {
  const current = engraveSmartHeightDraftFromIntent(input.intent)
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'selected_paths') throw new Error('Engrave Smart Height path scope is missing.')
  const next = { ...current, ...input.patch }
  const rebuilt = buildEngraveSmartHeightIntent({
    setupId: input.setupId,
    safetyIntent: input.safetyIntent ?? {
      clearance: {
        reference: input.intent.safety.clearance.reference,
        offset: input.intent.safety.clearance.offsetMm,
        provenance: input.intent.safety.clearance.owner.kind === 'user_override'
          ? 'user'
          : 'inferred',
      },
      retract: {
        reference: input.intent.safety.retract.reference,
        offset: input.intent.safety.retract.offsetMm,
        provenance: input.intent.safety.retract.owner.kind === 'user_override'
          ? 'user'
          : 'inferred',
      },
      feed: {
        reference: input.intent.safety.feed.reference,
        offset: input.intent.safety.feed.offsetMm,
        provenance: input.intent.safety.feed.owner.kind === 'user_override'
          ? 'user'
          : 'inferred',
      },
    },
    ...next,
    scope,
  })
  return input.intent.planeOverrides
    ? { ...rebuilt, planeOverrides: input.intent.planeOverrides }
    : rebuilt
}

export function buildEngraveSmartHeightEvidenceContext(
  input: EngraveSmartHeightEvidenceInput,
): HeightEvidenceContext {
  if (input.intent.policy.operationType !== 'engrave') {
    throw new Error('Engrave evidence requires Engrave intent.')
  }
  const formula = formulaFromIntent(input.intent)
  engraveSmartHeightDraftFromIntent(input.intent)
  const authoredScope = input.intent.machining.scope.value
  if (authoredScope.kind !== 'selected_paths') {
    throw new Error('Engrave evidence requires selected path scope.')
  }
  const currentScope = validateScope(input.scope)
  if (!sameScope(authoredScope, currentScope)) {
    throw new EngraveSmartHeightError({
      code: 'stale_dependency',
      message: 'The selected Engrave path scope changed. Re-open the operation and confirm the replacement paths.',
    })
  }
  const datum = finite(input.resolvedDatumMachineMm, 'Engrave resolved datum')
  const wcsOrigin = finite(input.wcsOriginMachineMm, 'Engrave WCS origin')
  const toolId = input.tool.id.trim()
  if (!toolId) throw new Error('Engrave tool id cannot be blank.')
  if (!input.datumFingerprint.trim()) throw new Error('Engrave datum fingerprint cannot be blank.')

  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const datumId = `selected-plane:${input.operationId}`
  const toolIdNode = `tool:${toolId}`

  const followSurface = input.intent.policy.variant === 'surface_following'
  const surface = input.surface
  if (followSurface && !surface) {
    throw new EngraveSmartHeightError({
      code: 'missing_evidence',
      message: 'Surface-following Engrave needs the part surface sampled under its paths.',
    })
  }
  let effectiveDatum = datum
  const startDependencyNodeIds = [datumId, toolIdNode]
  const remainingMaterialNodes: SmartHeightEvidenceNode[] = []
  const surfaceNodes: SmartHeightEvidenceNode[] = []

  if (followSurface && surface) {
    // The cut rides the surface, so its envelope is the surface's own span:
    // Material Start at the highest surface point, Cutter End the depth below
    // the lowest. The datum plane plays no part.
    const low = finite(surface.minMachineMm, 'Engrave surface low point')
    const high = finite(surface.maxMachineMm, 'Engrave surface high point')
    if (low > high) throw new Error('Engrave surface low point is above its high point.')
    const artifactId = surface.artifactId.trim()
    if (!artifactId || !surface.fingerprint.trim()) {
      throw new Error('Engrave surface evidence needs an artifact id and fingerprint.')
    }
    const surfaceId = `engrave-surface:${input.operationId}`
    surfaceNodes.push({
      id: surfaceId,
      kind: 'target_surface_field',
      role: 'target_artifact',
      entityId: artifactId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: surface.fingerprint,
      scalar: { frame: 'machine', valueMm: low },
      spatial: {
        artifactId,
        schemaVersion: 1,
        representation: 'engrave_surface_height_grid',
        frame: 'machine',
        boundsMm: {
          minX: surface.bounds.minX, minY: surface.bounds.minY, minZ: low,
          maxX: surface.bounds.maxX, maxY: surface.bounds.maxY, maxZ: high,
        },
        fingerprint: surface.fingerprint,
      },
    })
    effectiveDatum = high
    startDependencyNodeIds.push(surfaceId)
  }

  if (!followSurface && input.remainingMaterial?.compatible) {
    const remaining = input.remainingMaterial
    const artifactId = remaining.artifactId.trim()
    if (!artifactId) throw new Error('Engrave remaining material artifact id cannot be blank.')
    const materialId = `remaining-material:${artifactId}`
    const remainingTop = finite(remaining.materialTopMachineMm, 'Engrave remaining material Top')
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

  const resolvedDepthMm = resolvedDepthForTool(formula, input.tool)
  const materialStart = effectiveDatum + formula.axialOffsetMm
  const cutterEnd = followSurface && surface
    ? surface.minMachineMm + formula.axialOffsetMm - resolvedDepthMm
    : materialStart - resolvedDepthMm
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
    ...surfaceNodes,
    {
      id: datumId,
      kind: 'selected_plane',
      role: 'selected_plane',
      entityId: input.operationId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: fingerprint(input.datumFingerprint, {
        datumPlane: formula.datumPlane,
        datumMachineMm: datum,
      }),
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
      id: `engrave-formula:${input.operationId}:start`,
      kind: 'strategy_allowance',
      role: 'formula_material_start',
      entityId: input.operationId,
      dependencyNodeIds: startDependencyNodeIds,
      dependencyFingerprint: formulaFingerprint,
      scalar: { frame: 'machine', valueMm: materialStart },
    },
    {
      id: `engrave-formula:${input.operationId}:end`,
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
    operationType: 'engrave',
    wcsOriginMachineMm: wcsOrigin,
    evidence: nodes,
  }
}

export function resolveEngraveSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
}): ResolvedEngraveSmartHeights {
  if (input.intent.policy.operationType !== 'engrave' || input.evidence.operationType !== 'engrave') {
    throw new EngraveSmartHeightError({
      code: 'policy_mismatch',
      message: 'Engrave Smart Height received non-Engrave intent or evidence.',
    })
  }
  const formula = formulaFromIntent(input.intent)
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new EngraveSmartHeightError(result.refusal)
  const plan = result.plan
  const feed = plan.safety.feed
  const cutterEnd = plan.machining.cutterCenterEnd
  if (!feed || !cutterEnd) {
    throw new EngraveSmartHeightError({
      code: 'invalid_evidence',
      message: 'Engrave Smart Height did not resolve Feed and cutter endpoints.',
    })
  }
  const resolvedDepthMm = plan.machining.materialStart.wcsMm - cutterEnd.wcsMm
  const inferred = (offset: number) => ({
    reference: 'wcs_plane' as const,
    offset,
    provenance: 'inferred' as const,
  })
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
    resolvedDepthMm,
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
