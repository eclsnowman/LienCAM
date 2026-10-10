import type {
  HeightIntentV1,
  HeightParams,
  HeightPlaneName,
  HeightReference,
  ResolvedHeightSnapshotV1,
  HeightValueIntent,
  Operation,
  OperationType,
  Setup,
} from '../../types'
import { projectSetupHeightParams } from './newOperationHeightDefaults'
import { validatePersistedSmartHeightState } from './smartHeights/authority'

export interface HeightReferenceContext {
  wcsOriginZ: number
  referenceWcsZ: Partial<Record<Exclude<HeightReference, HeightPlaneName>, number>>
  dependencyIds?: readonly string[]
}

export interface ResolvedHeightValue {
  wcsZ: number
  machineZ: number
  intent: HeightValueIntent
}

export interface ResolvedHeightEnvelope {
  version: 1
  clearanceZ: number
  retractZ: number
  feedZ: number
  topZ: number
  bottomZ: number
  wcs: Record<HeightPlaneName, number>
  values: Record<HeightPlaneName, ResolvedHeightValue>
  dependencyIds: readonly string[]
}

export type ResolvedMachineHeights = Pick<
  ResolvedHeightEnvelope,
  'clearanceZ' | 'retractZ' | 'feedZ' | 'topZ' | 'bottomZ'
>

/** Convert a world-space WCS origin into a geometry-local compute frame. */
export function localizeMachineHeightOriginZ(
  worldWcsOriginZ: number,
  geometryPositionZ: number,
): number {
  return worldWcsOriginZ - geometryPositionZ
}

/** Translate a complete local height envelope beside world-placed toolpath moves. */
export function worldPlaceResolvedHeights(
  heights: ResolvedMachineHeights,
  geometryPositionZ: number,
): ResolvedMachineHeights {
  return {
    clearanceZ: heights.clearanceZ + geometryPositionZ,
    retractZ: heights.retractZ + geometryPositionZ,
    feedZ: heights.feedZ + geometryPositionZ,
    topZ: heights.topZ + geometryPositionZ,
    bottomZ: heights.bottomZ + geometryPositionZ,
  }
}

export function snapshotHeightEnvelope(
  envelope: ResolvedHeightEnvelope,
  authoredIntent?: HeightIntentV1,
): ResolvedHeightSnapshotV1 {
  return {
    version: 1,
    wcs: { ...envelope.wcs },
    machine: Object.fromEntries(HEIGHT_PLANES.map((plane) => [
      plane, envelope.values[plane].machineZ,
    ])) as Record<HeightPlaneName, number>,
    intent: authoredIntent ? {
      version: 1,
      clearance: { ...authoredIntent.clearance },
      retract: { ...authoredIntent.retract },
      feed: { ...authoredIntent.feed },
      top: { ...authoredIntent.top },
      bottom: { ...authoredIntent.bottom },
    } : {
      version: 1,
      clearance: { ...envelope.values.clearance.intent },
      retract: { ...envelope.values.retract.intent },
      feed: { ...envelope.values.feed.intent },
      top: { ...envelope.values.top.intent },
      bottom: { ...envelope.values.bottom.intent },
    },
    dependencyIds: [...envelope.dependencyIds],
  }
}

export class HeightIntentResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeightIntentResolutionError'
  }
}

const HEIGHT_PLANES: readonly HeightPlaneName[] = [
  'clearance', 'retract', 'feed', 'top', 'bottom',
]

/** Every live operation shares the same authored transition-plane contract. */
export function operationHeightPlaneNames(_operationType: OperationType): readonly HeightPlaneName[] {
  return HEIGHT_PLANES
}

function value(reference: HeightReference, offset: number, provenance: HeightValueIntent['provenance']): HeightValueIntent {
  return { reference, offset, provenance }
}

export function defaultHeightIntent(_operationType?: OperationType): HeightIntentV1 {
  return {
    version: 1,
    clearance: value('retract', 10, 'default'),
    retract: value('stock_top', 5, 'default'),
    feed: value('top', 5, 'default'),
    top: value('stock_top', 0, 'default'),
    bottom: value('top', -5, 'default'),
  }
}

export function cloneHeightIntent(intent: HeightIntentV1): HeightIntentV1 {
  return {
    version: 1,
    clearance: { ...intent.clearance },
    retract: { ...intent.retract },
    feed: { ...intent.feed },
    top: { ...intent.top },
    bottom: { ...intent.bottom },
  }
}

/** Return a writable intent record even for an unmigrated in-memory fixture.
 * Missing intent cannot preserve a reference that was never recorded, so its
 * truthful representation is the five existing WCS-relative flat values. */
export function heightIntentForEdit(heights: HeightParams): HeightIntentV1 {
  if (heights.heightIntent?.version === 1) return cloneHeightIntent(heights.heightIntent)
  return {
    version: 1,
    clearance: value('wcs_plane', heights.clearanceHeight, 'inferred'),
    retract: value('wcs_plane', heights.retractHeight, 'inferred'),
    feed: value('wcs_plane', heights.feedHeight, 'inferred'),
    top: value('wcs_plane', heights.topHeight, 'inferred'),
    bottom: value('wcs_plane', heights.bottomHeight, 'inferred'),
  }
}

export type ExternalHeightReferenceResolver = (
  reference: Exclude<HeightReference, HeightPlaneName>,
) => number | undefined

/** Walk a plane's authored reference chain down to a live WCS Z, the same
 * shape resolveHeightIntent resolves, but sourcing external references live
 * (through `resolveExternalReference`) instead of from a frozen snapshot. A
 * plane whose reference is itself another plane (e.g. feed -> top) recurses
 * through the CURRENT authored chain rather than a legacy mirror that a
 * pending setup-level change has not yet recomputed. */
function resolvePlaneReferenceWcsZ(
  intent: HeightIntentV1,
  plane: HeightPlaneName,
  resolveExternalReference: ExternalHeightReferenceResolver | undefined,
  resolving: Set<HeightPlaneName> = new Set(),
): number | undefined {
  if (resolving.has(plane)) return undefined
  resolving.add(plane)
  const reference = intent[plane].reference
  const referenceZ = HEIGHT_PLANES.includes(reference as HeightPlaneName)
    ? resolvePlaneReferenceWcsZ(intent, reference as HeightPlaneName, resolveExternalReference, resolving)
    : reference === 'wcs_plane'
      ? 0
      : resolveExternalReference?.(reference as Exclude<HeightReference, HeightPlaneName>)
  resolving.delete(plane)
  if (referenceZ === undefined || !Number.isFinite(referenceZ)) return undefined
  return referenceZ + intent[plane].offset
}

/** Keep the edited plane's authored reference while back-solving its offset.
 * The reference is resolved LIVE - through the same authored chain the Smart
 * Height V2 resolver walks - rather than from the legacy flat mirror, which a
 * pending setup-level change (e.g. a new material start) may not have
 * recomputed yet. External references must be resolved by the UI's real
 * project context; when unavailable, the typed WCS value becomes an explicit
 * absolute instead of retaining an unprovable reference. */
export function heightIntentAfterNumericEdit(
  heights: HeightParams,
  plane: HeightPlaneName,
  resolvedWcsZ: number,
  resolveExternalReference?: ExternalHeightReferenceResolver,
): HeightIntentV1 {
  const intent = heightIntentForEdit(heights)
  const reference = intent[plane].reference
  const referenceWcsZ = HEIGHT_PLANES.includes(reference as HeightPlaneName)
    ? resolvePlaneReferenceWcsZ(intent, reference as HeightPlaneName, resolveExternalReference)
    : reference === 'wcs_plane'
      ? 0
      : resolveExternalReference?.(reference as Exclude<HeightReference, HeightPlaneName>)

  intent[plane] = referenceWcsZ !== undefined && Number.isFinite(referenceWcsZ)
    ? value(reference, resolvedWcsZ - referenceWcsZ, 'user')
    : value('wcs_plane', resolvedWcsZ, 'user')
  return intent
}

/** Reference/offset controls author the semantic record directly. */
export function heightIntentAfterReferenceEdit(
  heights: HeightParams,
  plane: HeightPlaneName,
  reference: HeightReference,
  offset: number,
): HeightIntentV1 {
  const intent = heightIntentForEdit(heights)
  intent[plane] = value(reference, offset, 'user')
  return intent
}

/** Missing setup defaults are deliberately interpreted as the canonical
 * defaults. The v16 migration materializes this value for persisted projects,
 * while this read helper also keeps hand-built/test setups safe. */
export function setupDefaultHeightIntent(
  setup: Pick<Setup, 'defaultHeightIntent'>,
): HeightIntentV1 {
  return cloneHeightIntent(setup.defaultHeightIntent ?? defaultHeightIntent())
}

export type OperationSafetyPlane = 'clearance' | 'retract' | 'feed'

/** Project a height formula into operation authoring provenance. Setup-level
 * edits may themselves be tagged `user`, but they remain Smart/Setup-owned when
 * inherited by an operation. Only planes explicitly edited on the operation
 * are projected as user overrides. A plane still carrying the untouched
 * canonical `default` (never customized by setup or user) keeps that marker
 * instead of collapsing to `inferred`, so a policy that only rebinds a truly
 * generic default (e.g. Parallel 3D's stock-top retract, which can legally
 * have no stock) can still tell it apart from a deliberate setup choice. */
export function operationSafetyHeightIntent(
  intent: HeightIntentV1,
  userOverridePlanes: ReadonlySet<OperationSafetyPlane>,
): HeightIntentV1 {
  const safetyPlane = (plane: OperationSafetyPlane): HeightValueIntent => ({
    ...intent[plane],
    provenance: userOverridePlanes.has(plane)
      ? 'user'
      : intent[plane].provenance === 'default' ? 'default' : 'inferred',
  })
  return {
    ...cloneHeightIntent(intent),
    clearance: safetyPlane('clearance'),
    retract: safetyPlane('retract'),
    feed: safetyPlane('feed'),
  }
}

export function operationSafetyUserOverridePlanes(
  operation: Pick<Operation, 'smartHeight'> | undefined,
): Set<OperationSafetyPlane> {
  const validated = operation?.smartHeight === undefined
    ? undefined
    : validatePersistedSmartHeightState(operation.smartHeight)
  if (!validated?.ok) return new Set()
  const safety = validated.state.intent.safety
  return new Set<OperationSafetyPlane>([
    ...(safety.clearance.owner.kind === 'user_override' ? ['clearance' as const] : []),
    ...(safety.retract.owner.kind === 'user_override' ? ['retract' as const] : []),
    ...(safety.feed.owner.kind === 'user_override' ? ['feed' as const] : []),
  ])
}

const SETUP_REFERENCE_ZERO: HeightReferenceContext['referenceWcsZ'] = {
  stock_top: 0,
  stock_bottom: 0,
  model_top: 0,
  model_bottom: 0,
  geometry_plane: 0,
  selected_feature_top: 0,
  selected_feature_bottom: 0,
  picked_surface: 0,
  wcs_plane: 0,
  machine_plane: 0,
  remaining_stock: 0,
}

/** Project a setup's semantic intent into the legacy numeric HeightParams that
 * existing operation builders still consume. External reference planes are
 * normalized to WCS Z0; the intent remains authoritative and is resolved
 * against real stock/model context at compute time. */
export function heightParamsFromSetupIntent(intent: HeightIntentV1): HeightParams {
  const authored = cloneHeightIntent(intent)
  resolveHeightIntent(authored, {
    wcsOriginZ: 0,
    referenceWcsZ: SETUP_REFERENCE_ZERO,
  })
  return projectSetupHeightParams(authored)
}

function sameHeightValue(a: HeightValueIntent, b: HeightValueIntent): boolean {
  return a.reference === b.reference &&
    a.offset === b.offset &&
    a.provenance === b.provenance
}

export function sameHeightIntent(a: HeightIntentV1 | undefined, b: HeightIntentV1): boolean {
  return a?.version === 1 &&
    sameHeightValue(a.clearance, b.clearance) &&
    sameHeightValue(a.retract, b.retract) &&
    sameHeightValue(a.feed, b.feed) &&
    sameHeightValue(a.top, b.top) &&
    sameHeightValue(a.bottom, b.bottom)
}

export type SmartHeightSafetyOwnership = 'setup' | 'mixed' | 'operation'

/** V2 ownership is component-level and comes from the authored safety nodes. */
export function smartHeightSafetyOwnership(
  op: Pick<Operation, 'smartHeight'>,
): SmartHeightSafetyOwnership | 'invalid' {
  const validated = validatePersistedSmartHeightState(op.smartHeight)
  if (!validated.ok) return 'invalid'
  const safety = validated.state.intent.safety
  const owners = [safety.clearance.owner, safety.retract.owner, safety.feed.owner]
  const setupCount = owners.filter(owner => owner.kind === 'setup').length
  if (setupCount === owners.length) return 'setup'
  if (setupCount > 0) return 'mixed'
  return 'operation'
}

/** Refresh Setup-owned V2 safety components while preserving every
 * operation-policy and user-owned machining component. `force` is the explicit
 * Properties-panel reset action; ordinary Setup edits only propagate through
 * nodes that are already Setup-owned. Invalid/old operations stay untouched so
 * the UI can require the operator to repair and resave them. */
export function refreshSetupOwnedSmartHeightSafety(
  op: Operation,
  setupId: string,
  setupIntent: HeightIntentV1,
  force = false,
): Pick<Operation, 'heights' | 'smartHeight'> | undefined {
  const validated = validatePersistedSmartHeightState(op.smartHeight)
  if (!validated.ok) return undefined
  const currentIntent = validated.state.intent
  const setupOwner = { kind: 'setup' as const, setupId }
  const authored = cloneHeightIntent(op.heights.heightIntent ?? setupIntent)
  const projectedSetup = heightParamsFromSetupIntent(setupIntent)
  const nextSafety = { ...currentIntent.safety }
  const nextHeights = { ...op.heights, heightIntent: authored }
  let changed = false

  const refresh = (plane: 'clearance' | 'retract' | 'feed') => {
    const current = currentIntent.safety[plane]
    if (current === undefined || (!force && current.owner.kind !== 'setup')) return
    changed = true
    const setupValue = setupIntent[plane]
    nextSafety[plane] = {
      reference: setupValue.reference,
      offsetMm: setupValue.offset,
      owner: setupOwner,
    }
    authored[plane] = { ...setupValue }
    if (plane === 'clearance') {
      nextHeights.clearanceHeight = projectedSetup.clearanceHeight
      nextHeights.clearanceHeightMode = projectedSetup.clearanceHeightMode
    } else if (plane === 'retract') {
      nextHeights.retractHeight = projectedSetup.retractHeight
    } else {
      nextHeights.feedHeight = projectedSetup.feedHeight
    }
  }
  refresh('clearance')
  refresh('retract')
  refresh('feed')
  if (!changed) return undefined

  return {
    heights: nextHeights,
    smartHeight: {
      kind: 'smart_v2',
      intent: { ...currentIntent, safety: nextSafety },
    },
  }
}

type LegacyHeightReference =
  | 'absolute' | 'stock_top' | 'stock_bottom' | 'model_top'
  | 'geometry_face' | 'machine_floor' | 'wcs_plane' | 'picked_plane'

function mapLegacyReference(reference: LegacyHeightReference): HeightReference {
  switch (reference) {
    case 'absolute': return 'wcs_plane'
    case 'geometry_face': return 'geometry_plane'
    case 'machine_floor': return 'machine_plane'
    case 'picked_plane': return 'picked_surface'
    default: return reference
  }
}

function legacyTopIntent(heights: HeightParams): HeightValueIntent {
  switch (heights.topHeightMode) {
    case 'stock_top': return value('stock_top', heights.topHeight, 'user')
    case 'model_top': return value('model_top', heights.topHeight, 'user')
    case 'selected_face': return value('selected_feature_top', 0, 'user')
    case 'absolute': return value('wcs_plane', heights.topHeight, 'user')
  }
}

function legacyBottomIntent(heights: HeightParams): HeightValueIntent {
  switch (heights.bottomHeightMode) {
    case 'model_bottom': return value('model_bottom', heights.bottomHeight, 'user')
    case 'selected_face': return value('selected_feature_bottom', 0, 'user')
    case 'absolute': return value('wcs_plane', heights.bottomHeight, 'user')
  }
}

function referenceGovernsTop(op: Pick<Operation, 'type' | 'params'>): boolean {
  if (op.type === 'face' || op.type === 'engrave' || op.type === 'chamfer') return true
  if (op.type !== 'thread_mill') return false
  const params = op.params as { threadKind?: string; externalReference?: string }
  return params.threadKind !== 'external' || (params.externalReference ?? 'top') === 'top'
}

export function legacyHeightIntentForOperation(
  op: Pick<Operation, 'type' | 'heights' | 'params'>,
): HeightIntentV1 {
  if (op.heights.heightIntent?.version === 1) return op.heights.heightIntent
  const params = op.params as {
    heightReference?: LegacyHeightReference
    planeOffset?: number
    chamferWidth?: number
    tipOffset?: number
    threadDepth?: number
  }
  let top = legacyTopIntent(op.heights)
  let bottom = legacyBottomIntent(op.heights)
  if (params.heightReference) {
    const referenced = value(
      mapLegacyReference(params.heightReference),
      params.planeOffset ?? 0,
      'user',
    )
    if (referenceGovernsTop(op)) top = referenced
    else bottom = referenced
  }
  if (op.type === 'chamfer') {
    bottom = value('top', -((params.chamferWidth ?? 0) + (params.tipOffset ?? 0)), 'inferred')
  } else if (op.type === 'thread_mill') {
    const depth = params.threadDepth ?? 0
    if (referenceGovernsTop(op)) bottom = value('top', -depth, 'inferred')
    else top = value('bottom', depth, 'inferred')
  }
  return {
    version: 1,
    clearance: value('wcs_plane', op.heights.clearanceHeight, 'user'),
    retract: value('wcs_plane', op.heights.retractHeight, 'user'),
    feed: value('wcs_plane', op.heights.feedHeight, 'user'),
    top,
    bottom,
  }
}

export function resolveHeightIntent(
  intent: HeightIntentV1,
  context: HeightReferenceContext,
): ResolvedHeightEnvelope {
  if (intent.version !== 1) {
    throw new HeightIntentResolutionError(`Unsupported height intent version '${String((intent as { version?: unknown }).version)}'`)
  }
  const resolving = new Set<HeightPlaneName>()
  const resolved = new Map<HeightPlaneName, number>()
  const resolvePlane = (plane: HeightPlaneName): number => {
    const cached = resolved.get(plane)
    if (cached !== undefined) return cached
    if (resolving.has(plane)) {
      throw new HeightIntentResolutionError(`Height reference cycle includes '${plane}'`)
    }
    resolving.add(plane)
    const authored = intent[plane]
    if (!Number.isFinite(authored.offset)) {
      throw new HeightIntentResolutionError(`${plane} offset must be finite`)
    }
    const referenceZ = HEIGHT_PLANES.includes(authored.reference as HeightPlaneName)
      ? resolvePlane(authored.reference as HeightPlaneName)
      : context.referenceWcsZ[authored.reference as Exclude<HeightReference, HeightPlaneName>]
    if (referenceZ === undefined || !Number.isFinite(referenceZ)) {
      throw new HeightIntentResolutionError(
        `${plane} reference '${authored.reference}' is unavailable`,
      )
    }
    const wcsZ = referenceZ + authored.offset
    resolving.delete(plane)
    resolved.set(plane, wcsZ)
    return wcsZ
  }
  const wcs = Object.fromEntries(HEIGHT_PLANES.map((plane) => [plane, resolvePlane(plane)])) as Record<HeightPlaneName, number>
  if (!(wcs.clearance >= wcs.retract && wcs.retract >= wcs.feed &&
        wcs.feed >= wcs.top && wcs.top > wcs.bottom)) {
    throw new HeightIntentResolutionError(
      `Unsafe height order: clearance ${wcs.clearance}, retract ${wcs.retract}, feed ${wcs.feed}, top ${wcs.top}, bottom ${wcs.bottom}`,
    )
  }
  const values = Object.fromEntries(HEIGHT_PLANES.map((plane) => [plane, {
    wcsZ: wcs[plane],
    machineZ: wcs[plane] + context.wcsOriginZ,
    intent: intent[plane],
  }])) as Record<HeightPlaneName, ResolvedHeightValue>
  return {
    version: 1,
    clearanceZ: values.clearance.machineZ,
    retractZ: values.retract.machineZ,
    feedZ: values.feed.machineZ,
    topZ: values.top.machineZ,
    bottomZ: values.bottom.machineZ,
    wcs,
    values,
    dependencyIds: [...(context.dependencyIds ?? [])],
  }
}

export function envelopeFromResolvedWcsHeights(
  heights: Pick<HeightParams, 'clearanceHeight' | 'retractHeight' | 'feedHeight' | 'topHeight' | 'bottomHeight'>,
  wcsOriginZ: number,
  dependencyIds: readonly string[] = [],
): ResolvedHeightEnvelope {
  const resolvedIntent: HeightIntentV1 = {
    version: 1,
    clearance: value('wcs_plane', heights.clearanceHeight, 'inferred'),
    retract: value('wcs_plane', heights.retractHeight, 'inferred'),
    feed: value('wcs_plane', heights.feedHeight, 'inferred'),
    top: value('wcs_plane', heights.topHeight, 'inferred'),
    bottom: value('wcs_plane', heights.bottomHeight, 'inferred'),
  }
  return resolveHeightIntent(resolvedIntent, {
    wcsOriginZ,
    referenceWcsZ: { wcs_plane: 0 },
    dependencyIds,
  })
}

export function envelopeFromResolvedMachineHeights(
  heights: { clearanceZ: number; retractZ: number; feedZ: number; topZ: number; bottomZ: number },
  wcsOriginZ: number,
  dependencyIds: readonly string[] = [],
): ResolvedHeightEnvelope {
  return envelopeFromResolvedWcsHeights({
    clearanceHeight: heights.clearanceZ - wcsOriginZ,
    retractHeight: heights.retractZ - wcsOriginZ,
    feedHeight: heights.feedZ - wcsOriginZ,
    topHeight: heights.topZ - wcsOriginZ,
    bottomHeight: heights.bottomZ - wcsOriginZ,
  }, wcsOriginZ, dependencyIds)
}

export function resolveMeshBoundHeightEnvelope(
  heights: Pick<HeightParams, 'clearanceHeight' | 'retractHeight' | 'feedHeight'>,
  wcsOriginZ: number,
  meshBoundsZ: { min: number; max: number },
  dependencyIds: readonly string[] = [],
): ResolvedHeightEnvelope {
  const topZ = meshBoundsZ.max
  const bottomZ = meshBoundsZ.min
  const feedZ = Math.max(wcsOriginZ + heights.feedHeight, topZ)
  const retractZ = Math.max(wcsOriginZ + heights.retractHeight, feedZ)
  const clearanceZ = Math.max(wcsOriginZ + heights.clearanceHeight, retractZ)
  return envelopeFromResolvedMachineHeights({
    clearanceZ, retractZ, feedZ, topZ, bottomZ,
  }, wcsOriginZ, dependencyIds)
}

export function operationHeightPlaneDisplay(
  operation: Pick<Operation, 'resolvedHeights'>,
  _wcsOriginZ: number,
): Record<HeightPlaneName, number> | undefined {
  if (operation.resolvedHeights?.version === 1) {
    return { ...operation.resolvedHeights.machine }
  }
  return undefined
}
