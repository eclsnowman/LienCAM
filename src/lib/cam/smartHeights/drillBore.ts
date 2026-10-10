import type { HeightIntentV1, HeightParams, ImportedGeometry, Tool } from '../../../types'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type ResolvedHeightPlanV2,
  type SmartHeightEvidenceNode,
  type SmartHeightRevisionStamp,
  type StableFeatureReference,
} from './types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type DrillBoreOperationType = 'drill' | 'bore'
export type DrillBoreSmartHeightMode = 'detected_features' | 'explicit_depth'

export interface DrillBoreDetectedFeatureEvidence {
  loopId: string
  feature: StableFeatureReference
  topMachineMm: number
  floorMachineMm: number
  fingerprint: string
  /** WO-2678: the detected hole runs through the part (true) or ends at a
   * blind floor with part below it (false). Absent: not known. */
  through?: boolean
}

export interface DrillBoreStockEvidence {
  stockId: string
  topMachineMm: number
  bottomMachineMm: number
  fingerprint: string
}

/**
 * WO-1641: what the ENABLED earlier operations of this setup actually left over
 * the holes being drilled. Same shape every other family's remaining-material
 * evidence takes, so `current_or_initial_material` resolves it the same way:
 * present, the Top follows it; absent, the Top is the stock as loaded.
 */
export interface DrillBoreRemainingMaterialEvidence {
  artifactId: string
  materialTopMachineMm: number
  fingerprint: string
  representation: string
  compatible: boolean
}

export interface DrillBoreSmartHeightIntentInput {
  operationType: DrillBoreOperationType
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  mode: DrillBoreSmartHeightMode
  features?: DrillBoreDetectedFeatureEvidence[]
  geometryIds?: string[]
  perFeatureEndOverridesWcsMm?: Record<string, number>
  explicitStartWcsMm?: number
  explicitEndWcsMm?: number
}

export interface DrillBoreSmartHeightEvidenceInput {
  operationType: DrillBoreOperationType
  mode: DrillBoreSmartHeightMode
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  geometryIds: string[]
  features?: DrillBoreDetectedFeatureEvidence[]
  owningStock?: DrillBoreStockEvidence
  remainingMaterial?: DrillBoreRemainingMaterialEvidence
  tool: Tool
  breakthroughMm?: number
}

export interface ResolvedDrillBoreFeatureEndpoint {
  loopId: string
  feature: StableFeatureReference
  physicalFloorWcsMm: number
  cutterCenterEndWcsMm: number
  source: 'detected' | 'override'
}

export interface ResolvedDrillBoreSmartHeights {
  plan: ResolvedHeightPlanV2
  workerHeights: HeightParams
  featureBottoms?: Record<string, number>
  featureEndpoints: ResolvedDrillBoreFeatureEndpoint[]
  snapshotIntent: HeightIntentV1
  pointCompensationMm: number
  breakthroughMm: number
  dependencyIds: string[]
}

export class DrillBoreSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(operationType: DrillBoreOperationType, refusal: SmartHeightRefusal) {
    super(`${operationType === 'drill' ? 'Drill' : 'Bore'} Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'DrillBoreSmartHeightError'
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

function nonNegative(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked < 0) throw new Error(`${label} cannot be negative.`)
  return checked
}

function featureKey(feature: StableFeatureReference): string {
  return [
    feature.modelItemId,
    feature.bodyId,
    feature.featureKind,
    feature.stableId,
    String(feature.sourceVersion),
    feature.sourceFingerprint,
  ].join('\u001f')
}

function validFeature(feature: StableFeatureReference, label: string): StableFeatureReference {
  if (!feature.modelItemId.trim() || !feature.bodyId.trim() || !feature.featureKind.trim() ||
      !feature.stableId.trim() || !feature.sourceFingerprint.trim() ||
      !Number.isInteger(feature.sourceVersion) || feature.sourceVersion < 1) {
    throw new Error(`${label} has an incomplete stable feature reference.`)
  }
  return { ...feature }
}

function validFeatures(
  features: readonly DrillBoreDetectedFeatureEvidence[] | undefined,
  label: string,
): DrillBoreDetectedFeatureEvidence[] {
  const checked = (features ?? []).map((item, index) => {
    const loopId = item.loopId.trim()
    if (!loopId) throw new Error(`${label} ${index + 1} has a blank loop id.`)
    const top = finite(item.topMachineMm, `${label} '${loopId}' top`)
    const floor = finite(item.floorMachineMm, `${label} '${loopId}' floor`)
    if (floor > top) throw new Error(`${label} '${loopId}' floor is above its top.`)
    if (!item.fingerprint.trim()) throw new Error(`${label} '${loopId}' has no evidence fingerprint.`)
    return {
      ...item,
      loopId,
      feature: validFeature(item.feature, `${label} '${loopId}'`),
      topMachineMm: top,
      floorMachineMm: floor,
    }
  })
  if (checked.length === 0) throw new Error(`${label} requires at least one detected feature.`)
  if (new Set(checked.map(item => item.loopId)).size !== checked.length) {
    throw new Error(`${label} contains duplicate loop ids.`)
  }
  if (new Set(checked.map(item => featureKey(item.feature))).size !== checked.length) {
    throw new Error(`${label} contains duplicate stable feature identities.`)
  }
  return checked
}

function evidenceFingerprint(prefix: string, values: unknown): string {
  return `${prefix}:${smartHeightEvidenceFingerprint(values)}`
}

/** Axial distance from a pointed tool's tip to its full-diameter shoulder.
 * This is a cutter-center allowance, not part of the physical hole floor. */
export function drillPointCompensationMm(tool: Tool): number {
  if (tool.type !== 'drill' && tool.type !== 'spot_drill' && tool.type !== 'center_drill') return 0
  const diameter = finite(tool.diameter, 'Drill tool diameter')
  const tipDiameter = finite(tool.tipDiameter ?? 0, 'Drill tool tip diameter')
  const angleFromAxisDeg = finite(tool.angleFromAxisDeg ?? 59, 'Drill tool point half-angle')
  if (diameter <= 0) throw new Error('Drill tool diameter must be greater than zero.')
  if (tipDiameter < 0 || tipDiameter >= diameter) {
    throw new Error('Drill tool tip diameter must be at least zero and smaller than the cutter diameter.')
  }
  if (angleFromAxisDeg <= 0 || angleFromAxisDeg >= 90) {
    throw new Error('Drill tool point half-angle must be greater than 0 deg and less than 90 deg.')
  }
  return ((diameter - tipDiameter) / 2) / Math.tan(angleFromAxisDeg * Math.PI / 180)
}

/** The tip's travel below the bottom, as drill point and breakthrough. Detected
 * floors take both, except that a Drill takes no point below a blind floor
 * (WO-2678, see `buildDrillBoreSmartHeightEvidenceContext`). WO-2514: an
 * explicit Target End is the tip, unless a Drill is asked to break through - then the full diameter passes the bottom by
 * the breakthrough, and the point length is added for the operator. Bore's
 * explicit end stays the tip. */
export function drillBoreEndAllowancesMm(input: {
  operationType: DrillBoreOperationType
  mode: DrillBoreSmartHeightMode
  tool: Tool
  breakthroughMm?: number
}): { pointCompensationMm: number; breakthroughMm: number } {
  if (input.mode === 'detected_features') {
    return {
      pointCompensationMm: input.operationType === 'drill' ? drillPointCompensationMm(input.tool) : 0,
      breakthroughMm: nonNegative(input.breakthroughMm ?? 0, 'Drill/Bore breakthrough'),
    }
  }
  if (input.operationType !== 'drill') return { pointCompensationMm: 0, breakthroughMm: 0 }
  const breakthrough = nonNegative(input.breakthroughMm ?? 0, 'Drill breakthrough')
  if (breakthrough <= 0) return { pointCompensationMm: 0, breakthroughMm: 0 }
  // A 180 deg flat-bottom drill (half-angle 90) has no point length.
  const flatPoint = input.tool.angleFromAxisDeg === 90
  return {
    pointCompensationMm: flatPoint ? 0 : drillPointCompensationMm(input.tool),
    breakthroughMm: breakthrough,
  }
}

/** WO-2516: the Break through a new Drill starts with on a through hole. */
export const DRILL_BREAK_THROUGH_DEFAULT_MM = 0.5

/** Why a Drill's Break through starts on or off. */
export type DrillBreakThroughDefaultReason =
  | 'through_holes'
  | 'blind_holes'
  | 'mixed_holes'
  | 'bottom_at_stock_bottom'
  | 'bottom_above_stock_bottom'

export interface DrillBreakThroughDefault {
  breakthroughMm: number
  reason: DrillBreakThroughDefaultReason
  throughHoles: number
  holes: number
}

/** A Target End this close to the stock bottom is at it. */
const STOCK_BOTTOM_TOLERANCE_MM = 1e-3

/** WO-2516: whether each picked loop is a hole that runs through, from the
 * hole detection the detected-features mode already binds (a hole's own
 * `through`: its floor reaches the solid's bottom). Undefined when any loop has
 * no detected hole - a flat circle has no floor of its own to judge. */
export function drillPickedHolesThrough(
  geometries: readonly ImportedGeometry[],
  loopIds: readonly string[],
): boolean[] | undefined {
  if (loopIds.length === 0) return undefined
  const through: boolean[] = []
  for (const loopId of loopIds) {
    let found: boolean | undefined
    for (const geometry of geometries) {
      const loop = (geometry.loops ?? []).find(candidate => candidate.id === loopId)
      if (!loop) continue
      const layer = (geometry.layers2d ?? []).find(candidate => candidate.id === loop.layerId)
      const feature = layer?.holes?.find(hole => hole.loopId === loopId) ??
        layer?.cylinders?.find(cylinder => cylinder.loopId === loopId && cylinder.kind === 'bore')
      if (feature) found = feature.through === true
    }
    if (found === undefined) return undefined
    through.push(found)
  }
  return through
}

/** WO-2516: the Break through a Drill starts with, from the hole it drills.
 * Detected floors follow the picked holes: on when every hole runs through
 * (one setting covers them all), off when any has a floor. An explicit depth
 * follows its Target End: on at or below the stock bottom, off above it.
 * Undefined when the facts are not known yet; the field then stays as it is. */
export function drillBreakThroughDefault(input:
  | { mode: 'detected_features'; holesThrough: readonly boolean[] | undefined }
  | { mode: 'explicit_depth'; bottomWcsMm: number | undefined; stockBottomWcsMm: number | undefined },
): DrillBreakThroughDefault | undefined {
  if (input.mode === 'detected_features') {
    const holes = input.holesThrough
    if (!holes || holes.length === 0) return undefined
    const throughHoles = holes.filter(Boolean).length
    const reason: DrillBreakThroughDefaultReason = throughHoles === holes.length
      ? 'through_holes'
      : throughHoles === 0 ? 'blind_holes' : 'mixed_holes'
    return {
      breakthroughMm: reason === 'through_holes' ? DRILL_BREAK_THROUGH_DEFAULT_MM : 0,
      reason,
      throughHoles,
      holes: holes.length,
    }
  }
  const { bottomWcsMm, stockBottomWcsMm } = input
  if (bottomWcsMm === undefined || stockBottomWcsMm === undefined ||
      !Number.isFinite(bottomWcsMm) || !Number.isFinite(stockBottomWcsMm)) return undefined
  const through = bottomWcsMm <= stockBottomWcsMm + STOCK_BOTTOM_TOLERANCE_MM
  return {
    breakthroughMm: through ? DRILL_BREAK_THROUGH_DEFAULT_MM : 0,
    reason: through ? 'bottom_at_stock_bottom' : 'bottom_above_stock_bottom',
    throughHoles: through ? 1 : 0,
    holes: 1,
  }
}

export function buildDrillBoreSmartHeightIntent(
  input: DrillBoreSmartHeightIntentInput,
): OperationHeightIntentV2 {
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']) => ({
    reference: value.reference,
    offsetMm: finite(value.offset, 'Drill/Bore safety offset'),
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  const safety = {
    clearance: safetyPlane(input.safetyIntent.clearance),
    retract: safetyPlane(input.safetyIntent.retract),
    feed: safetyPlane(input.safetyIntent.feed),
  }

  if (input.mode === 'detected_features') {
    const features = validFeatures(input.features, 'Detected Drill/Bore feature')
    const overrides = input.perFeatureEndOverridesWcsMm ?? {}
    const byLoopId = new Map(features.map(item => [item.loopId, item]))
    for (const loopId of Object.keys(overrides)) {
      if (!byLoopId.has(loopId)) {
        throw new Error(`Per-feature endpoint override '${loopId}' has no matching detected feature.`)
      }
    }
    return {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: input.operationType, variant: 'detected_features' },
      safety,
      machining: {
        start: { owner: policyOwner, value: { kind: 'current_material' } },
        end: { owner: policyOwner, value: { kind: 'detected_feature_floors' } },
        scope: {
          owner: policyOwner,
          value: { kind: 'selected_features', features: features.map(item => ({ ...item.feature })) },
        },
      },
      featureOverrides: Object.entries(overrides).map(([loopId, value]) => ({
        feature: { ...byLoopId.get(loopId)!.feature },
        cutterCenterEnd: {
          reference: 'wcs_plane',
          offsetMm: finite(value, `Per-feature endpoint override '${loopId}'`),
          owner: userOwner,
        },
      })),
    }
  }

  const geometryIds = (input.geometryIds ?? []).map(id => id.trim()).filter(Boolean)
  if (geometryIds.length === 0) throw new Error('Explicit-depth Drill/Bore intent requires selected geometry.')
  if (new Set(geometryIds).size !== geometryIds.length) {
    throw new Error('Explicit-depth Drill/Bore intent contains duplicate geometry ids.')
  }
  const start = finite(input.explicitStartWcsMm ?? NaN, 'Explicit Drill/Bore Material Start')
  const end = finite(input.explicitEndWcsMm ?? NaN, 'Explicit Drill/Bore Target End')
  if (start <= end) throw new Error('Explicit Drill/Bore Material Start must be above Target End.')
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: input.operationType, variant: 'explicit_depth' },
    safety,
    machining: {
      start: {
        owner: userOwner,
        value: {
          kind: 'explicit_plane',
          plane: { reference: 'wcs_plane', offsetMm: start, owner: userOwner },
        },
      },
      end: {
        owner: userOwner,
        value: {
          kind: 'bounded_plane',
          plane: { reference: 'wcs_plane', offsetMm: end, owner: userOwner },
        },
      },
      scope: {
        owner: policyOwner,
        value: { kind: 'selected_geometry', geometryIds },
      },
    },
  }
}

/** Build one exact evidence graph for creation preview and runtime dispatch. */
export function buildDrillBoreSmartHeightEvidenceContext(
  input: DrillBoreSmartHeightEvidenceInput,
): HeightEvidenceContext {
  const wcsOrigin = finite(input.wcsOriginMachineMm, 'Drill/Bore WCS origin')
  const geometryIds = input.geometryIds.map(id => id.trim()).filter(Boolean)
  if (new Set(geometryIds).size !== geometryIds.length) {
    throw new Error('Drill/Bore evidence contains duplicate geometry ids.')
  }
  const features = input.features?.length
    ? validFeatures(input.features, 'Detected Drill/Bore feature evidence')
    : []
  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const nodes: SmartHeightEvidenceNode[] = [
    {
      id: wcsId,
      kind: 'setup_wcs',
      role: 'wcs_origin',
      entityId: input.operationId,
      dependencyNodeIds: [],
      dependencyFingerprint: evidenceFingerprint(input.revision.setupRevision, wcsOrigin),
      scalar: { frame: 'machine', valueMm: wcsOrigin },
    },
    {
      id: scopeId,
      kind: 'operation_scope',
      role: 'scope',
      entityId: input.operationId,
      dependencyNodeIds: [wcsId],
      dependencyFingerprint: evidenceFingerprint(input.revision.operationRevision, {
        geometryIds,
        features: features.map(item => featureKey(item.feature)),
      }),
    },
  ]

  if (input.owningStock) {
    const stock = input.owningStock
    const stockId = stock.stockId.trim()
    if (!stockId) throw new Error('Drill/Bore owning stock id cannot be blank.')
    const top = finite(stock.topMachineMm, 'Drill/Bore owning stock top')
    const bottom = finite(stock.bottomMachineMm, 'Drill/Bore owning stock bottom')
    if (bottom > top) throw new Error('Drill/Bore owning stock bottom is above its top.')
    const fp = evidenceFingerprint(stock.fingerprint, { stockId, top, bottom })
    nodes.push(
      {
        id: `owning-stock:${stockId}:top`,
        kind: 'owning_stock',
        role: 'stock_top',
        entityId: stockId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: fp,
        scalar: { frame: 'machine', valueMm: top },
      },
      {
        id: `owning-stock:${stockId}:bottom`,
        kind: 'owning_stock',
        role: 'stock_bottom',
        entityId: stockId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: fp,
        scalar: { frame: 'machine', valueMm: bottom },
      },
    )
  }

  // WO-1641: a Drill after a Face that took 2 mm off starts at the faced top,
  // not at the block as loaded. No opt-in: the evidence is offered whenever the
  // earlier operations left the material lower than the stock.
  if (input.remainingMaterial?.compatible) {
    const remaining = input.remainingMaterial
    const artifactId = remaining.artifactId.trim()
    if (!artifactId) throw new Error('Drill/Bore remaining material artifact id cannot be blank.')
    const materialId = `remaining-material:${artifactId}`
    nodes.push(
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
          valueMm: finite(remaining.materialTopMachineMm, 'Drill/Bore remaining material Top'),
        },
      },
    )
  }

  const toolFingerprint = evidenceFingerprint(input.tool.id, {
    type: input.tool.type,
    diameter: input.tool.diameter,
    tipDiameter: input.tool.tipDiameter,
    angleFromAxisDeg: input.tool.angleFromAxisDeg,
  })
  nodes.push({
    id: `tool:${input.tool.id}`,
    kind: 'tool_geometry',
    role: 'tool',
    entityId: input.tool.id,
    dependencyNodeIds: [scopeId],
    dependencyFingerprint: toolFingerprint,
  })

  for (const item of features) {
    const key = featureKey(item.feature)
    const encoded = encodeURIComponent(key)
    nodes.push(
      {
        id: `detected-feature:${encoded}:top`,
        kind: 'detected_feature_floor',
        role: 'feature_top',
        entityId: item.loopId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: item.fingerprint,
        scalar: { frame: 'machine', valueMm: item.topMachineMm },
        feature: { ...item.feature },
      },
      {
        id: `detected-feature:${encoded}:floor`,
        kind: 'detected_feature_floor',
        role: 'feature_floor',
        entityId: item.loopId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: item.fingerprint,
        scalar: { frame: 'machine', valueMm: item.floorMachineMm },
        feature: { ...item.feature },
      },
    )
  }

  const {
    pointCompensationMm: pointCompensation,
    breakthroughMm: breakthrough,
  } = drillBoreEndAllowancesMm(input)
  // WO-2678 (the operator 2026-10-08: "Tip stops at the floor"): a drill cannot make a
  // flat floor, so on a blind one the point goes to the floor and the part is
  // never cut into; the top of the cone stays above it. Through holes keep the
  // point so the full diameter clears the bottom. When any picked hole is blind
  // the point belongs to each other hole by its stable identity; otherwise it
  // stays operation-wide, exactly as before. Unknown (no `through`) keeps the
  // point. Break through is the operator's own setting (off by default on a
  // blind hole, WO-2516) and stays operation-wide.
  const blindFloors = input.operationType === 'drill' && input.mode === 'detected_features'
    ? features.filter(item => item.through === false)
    : []
  const pointOwners: (DrillBoreDetectedFeatureEvidence | undefined)[] = blindFloors.length > 0
    ? features.filter(item => item.through !== false)
    : [undefined]
  if (pointCompensation > 0) {
    for (const owner of pointOwners) {
      nodes.push({
        id: owner
          ? `strategy-allowance:${input.operationId}:drill-point:${encodeURIComponent(featureKey(owner.feature))}`
          : `strategy-allowance:${input.operationId}:drill-point`,
        kind: 'strategy_allowance',
        role: 'cutter_end_allowance',
        entityId: input.operationId,
        dependencyNodeIds: [`tool:${input.tool.id}`],
        dependencyFingerprint: evidenceFingerprint(toolFingerprint, pointCompensation),
        scalar: { frame: 'machine', valueMm: -pointCompensation },
        ...(owner ? { feature: { ...owner.feature } } : {}),
      })
    }
  }
  if (breakthrough > 0) {
    nodes.push({
      id: `strategy-allowance:${input.operationId}:breakthrough`,
      kind: 'strategy_allowance',
      role: 'cutter_end_allowance',
      entityId: input.operationId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: evidenceFingerprint(input.revision.operationRevision, breakthrough),
      scalar: { frame: 'machine', valueMm: -breakthrough },
    })
  }

  return {
    revision: { ...input.revision },
    operationType: input.operationType,
    wcsOriginMachineMm: wcsOrigin,
    evidence: nodes,
  }
}

export function resolveDrillBoreSmartHeights(input: {
  operationType: DrillBoreOperationType
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  features?: DrillBoreDetectedFeatureEvidence[]
  tool: Tool
  breakthroughMm?: number
}): ResolvedDrillBoreSmartHeights {
  if (input.intent.policy.operationType !== input.operationType ||
      input.evidence.operationType !== input.operationType) {
    throw new DrillBoreSmartHeightError(input.operationType, {
      code: 'policy_mismatch',
      message: 'Drill/Bore Smart Height received mismatched operation intent or evidence.',
    })
  }
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new DrillBoreSmartHeightError(input.operationType, result.refusal)
  const plan = result.plan
  const feed = plan.safety.feed
  const resolvedFeatures = plan.machining.featureEndpoints ?? []
  const aggregateEnd = plan.machining.cutterCenterEnd?.wcsMm
    ?? (resolvedFeatures.length > 0
      ? Math.min(...resolvedFeatures.map(endpoint => endpoint.cutterCenterEnd.wcsMm))
      : undefined)
  if (!feed || aggregateEnd === undefined) {
    throw new DrillBoreSmartHeightError(input.operationType, {
      code: 'invalid_evidence',
      message: 'Drill/Bore Smart Height resolved an incomplete worker envelope.',
    })
  }

  const features = input.features ?? []
  const featureEndpoints = resolvedFeatures.map(endpoint => {
    const matches = features.filter(item => featureKey(item.feature) === featureKey(endpoint.feature))
    if (matches.length !== 1) {
      throw new DrillBoreSmartHeightError(input.operationType, {
        code: matches.length === 0 ? 'missing_evidence' : 'ambiguous_evidence',
        evidenceKind: 'detected_feature_floor',
        message: `Feature '${endpoint.feature.stableId}' does not map to exactly one worker loop.`,
      })
    }
    return {
      loopId: matches[0].loopId,
      feature: { ...endpoint.feature },
      physicalFloorWcsMm: endpoint.physicalTarget.wcsMm,
      cutterCenterEndWcsMm: endpoint.cutterCenterEnd.wcsMm,
      source: endpoint.cutterCenterEnd.owner.kind === 'user_override' ? 'override' as const : 'detected' as const,
    }
  })
  const allowances = drillBoreEndAllowancesMm({
    operationType: input.operationType,
    mode: input.intent.policy.variant === 'detected_features' ? 'detected_features' : 'explicit_depth',
    tool: input.tool,
    breakthroughMm: input.breakthroughMm,
  })
  const featureBottoms = featureEndpoints.length > 0
    ? Object.fromEntries(featureEndpoints.map(item => [item.loopId, item.cutterCenterEndWcsMm]))
    : undefined
  const inferred = (offset: number): HeightIntentV1['top'] => ({
    reference: 'wcs_plane',
    offset,
    provenance: 'inferred',
  })
  const snapshotIntent: HeightIntentV1 = {
    version: 1,
    clearance: inferred(plan.safety.clearance.wcsMm),
    retract: inferred(plan.safety.retract.wcsMm),
    feed: inferred(feed.wcsMm),
    top: inferred(plan.machining.materialStart.wcsMm),
    bottom: inferred(aggregateEnd),
  }
  const workerHeights: HeightParams = {
    clearanceHeight: plan.safety.clearance.wcsMm,
    clearanceHeightMode: 'absolute',
    retractHeight: plan.safety.retract.wcsMm,
    feedHeight: feed.wcsMm,
    topHeight: plan.machining.materialStart.wcsMm,
    topHeightMode: 'absolute',
    bottomHeight: aggregateEnd,
    bottomHeightMode: 'absolute',
    heightIntent: snapshotIntent,
  }
  return {
    plan,
    workerHeights,
    ...(featureBottoms ? { featureBottoms } : {}),
    featureEndpoints,
    snapshotIntent,
    pointCompensationMm: allowances.pointCompensationMm,
    breakthroughMm: allowances.breakthroughMm,
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) =>
      ids.indexOf(id) === index,
    ),
  }
}
