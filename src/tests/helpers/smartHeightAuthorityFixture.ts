// Smart Height V2 authority fixture for tests.
//
// Commit 2e5678b7 (2026-08-15) made a valid `smart_v2` envelope the ONLY
// runtime height authority: add, preview, compute and post all refuse an
// operation without one (src/lib/cam/smartHeights/authority.ts). Tests written
// before that cutover build operations straight from `heights`, so they are
// refused before any assertion about dispatch can run.
//
// Per ADR-0040 (no legacy before 1.0) the answer is to STAMP a valid envelope
// on the fixture, not to write a migration. This helper is that stamp. It
// delegates to the PRODUCTION intent builder for each family - the same code
// the operation dialogs run - so a fixture never carries a scope kind or
// variant the family's resolver would refuse. Safety planes come from the
// operation's own `heights` through the same legacy-intent bridge the post
// path uses, shaped as Operator's plane stack (clearance off retract, retract off
// the stock top, feed off top).
//
// It deliberately does not synthesise evidence graphs or resolved plans. A test
// that needs a resolved plan uses `smartHeightPlanFixture()`.

import {
  buildAdaptive3dSmartIntent,
  buildContourSmartHeightIntent,
  buildDrillBoreSmartHeightIntent,
  buildEngraveSmartHeightIntent,
  buildFaceSmartHeightIntent,
  buildParallel3dSmartIntent,
  buildScallop3dSmartIntent,
  buildPencil3dSmartIntent,
  buildSteepShallow3dSmartIntent,
  buildPlanarRoughSmartHeightIntent,
  buildThreadMillSmartHeightIntent,
  buildWaterline3dSmartIntent,
  OPERATION_HEIGHT_POLICIES,
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type AuthoredPlaneIntentV2,
  type MachiningEndIntent,
  type MachiningScopeIntent,
  type MaterialStartIntent,
  type OperationHeightPolicyIntent,
  type OperationHeightIntentV2,
  type SmartHeightIntentOwner,
} from '../../lib/cam/smartHeights'
import { defaultHeightIntent, legacyHeightIntentForOperation } from '../../lib/cam/heightIntent'
import type {
  HeightIntentV1,
  HeightParams,
  Operation,
  OperationType,
  PersistedOperationHeightState,
} from '../../types'

const ACCEPTED_ACTIVATIONS = new Set(['live', 'provisional'])

const PREFERRED_VARIANTS = [
  'through_stock',
  'explicit_depth',
  'stock_bottom',
  'model_bottom',
  'stock_rough',
  'geometry_floor',
  'target_face',
  'detected_features',
  'internal_top',
  'edge_width_formula',
  'target_surface',
  'initial_stock',
]

export function defaultSmartHeightVariant(type: OperationType): string {
  const policy = (OPERATION_HEIGHT_POLICIES as Record<string, {
    support: string
    variants: Record<string, { activation: { status: string } }>
  }>)[type]
  if (!policy || policy.support !== 'live') {
    throw new Error(
      `smartHeightAuthorityFixture: ${type} has no live Smart Height V2 policy in this build, ` +
      'so no fixture envelope can be valid for it.',
    )
  }
  const accepted = Object.entries(policy.variants)
    .filter(([, variant]) => ACCEPTED_ACTIVATIONS.has(variant.activation.status))
    .map(([name]) => name)
  const preferred = PREFERRED_VARIANTS.find(name => accepted.includes(name))
  const chosen = preferred ?? accepted[0]
  if (!chosen) {
    throw new Error(`smartHeightAuthorityFixture: ${type} has no active Smart Height V2 variant.`)
  }
  return chosen
}

export interface SmartHeightAuthorityFixtureOptions {
  /** Setup that owns the safety planes. Safety is Setup-authored by default,
   * which is what the product does. */
  setupId?: string
  /** Authored heights the fixture should agree with. Only the offsets are
   * read; the fixture never claims a resolved value. */
  heights?: Partial<HeightParams>
  /** Operation params (geometryId / loopIds / thread fields) the scope is
   * derived from when no explicit geometryIds are given. */
  params?: Record<string, unknown>
  /** Scope geometry for the machining intent. */
  geometryIds?: string[]
  /** Owning stock for families whose simplest variant is stock-relative
   * (face explicit depth). Defaults to 'stock-1'. */
  stockId?: string
  /** Explicit machining-end depth (mm below the material start) for the
   * families whose simplest variant is an explicit depth. Default 1. */
  explicitDepthMm?: number
}

function safetyIntentFor(
  type: OperationType,
  options: SmartHeightAuthorityFixtureOptions,
): Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> {
  if (options.heights) {
    const heights = { ...defaultHeightIntentHeights(), ...options.heights } as HeightParams
    return legacyHeightIntentForOperation({ type, heights, params: options.params ?? {} })
  }
  return defaultHeightIntent(type)
}

function defaultHeightIntentHeights(): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 5,
    topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -1, bottomHeightMode: 'absolute',
  }
}

function scopeGeometryIds(options: SmartHeightAuthorityFixtureOptions): string[] {
  if (options.geometryIds && options.geometryIds.length > 0) return options.geometryIds
  const geometryId = options.params?.geometryId
  if (typeof geometryId === 'string' && geometryId) return [geometryId]
  return ['geo-1']
}

/** Author the smallest intent the family's own builder accepts. */
export function smartHeightIntentFixture(
  type: OperationType,
  options: SmartHeightAuthorityFixtureOptions = {},
): OperationHeightIntentV2 {
  const setupId = options.setupId ?? 'setup-1'
  const safetyIntent = safetyIntentFor(type, options)
  const geometryIds = scopeGeometryIds(options)
  const params = options.params ?? {}
  const depthMm = options.explicitDepthMm ?? 1
  const explicitTargetWcsMm = -depthMm

  switch (type) {
    case 'face':
      return buildFaceSmartHeightIntent({
        setupId, safetyIntent, mode: 'explicit_depth', explicitTargetWcsMm,
        stockId: options.stockId ?? 'stock-1',
      })
    case 'contour_2d':
      return buildContourSmartHeightIntent({
        setupId, safetyIntent, mode: 'through_stock', geometryIds,
      })
    case 'pocket_2d':
    case 'adaptive_clearing_2d':
      return buildPlanarRoughSmartHeightIntent({
        setupId, operationType: type, safetyIntent, mode: 'explicit_depth',
        geometryIds, explicitTargetWcsMm,
      })
    case 'drill':
    case 'bore':
      return buildDrillBoreSmartHeightIntent({
        operationType: type, setupId, safetyIntent, mode: 'explicit_depth',
        geometryIds, explicitStartWcsMm: 0, explicitEndWcsMm: explicitTargetWcsMm,
      })
    case 'engrave':
      return buildEngraveSmartHeightIntent({
        setupId, safetyIntent,
        datumReference: 'stock_top', datumOffsetMm: 0, axialOffsetMm: 0,
        depth: { kind: 'explicit', depthMm },
        scope: {
          geometryIds,
          loopIds: Array.isArray(params.loopIds) && params.loopIds.length > 0
            ? (params.loopIds as string[])
            : ['loop-1'],
          includeOpen: true, includeClosed: true,
        },
      })
    case 'thread_mill':
      return buildThreadMillSmartHeightIntent({
        setupId, safetyIntent, source: 'explicit_band',
        threadKind: params.threadKind === 'external' ? 'external' : 'internal',
        externalReference: params.externalReference === 'base' ? 'base' : 'top',
        threadDepthMm: typeof params.threadDepth === 'number' ? params.threadDepth : depthMm,
        planeOffsetMm: typeof params.planeOffset === 'number' ? params.planeOffset : 0,
        datumReference: 'stock_top',
        geometryIds,
      })
    case 'parallel_3d':
      return buildParallel3dSmartIntent({ setupId, geometryIds, safetyIntent })
    case 'waterline_3d':
      return buildWaterline3dSmartIntent({ setupId, geometryIds, safetyIntent })
    case 'steep_shallow_3d':
      return buildSteepShallow3dSmartIntent({ setupId, geometryIds, safetyIntent })
    case 'scallop_3d':
      return buildScallop3dSmartIntent({ setupId, geometryIds, safetyIntent })
    case 'pencil_3d':
      return buildPencil3dSmartIntent({ setupId, geometryIds, safetyIntent })
    case 'adaptive_3d':
      return buildAdaptive3dSmartIntent({ setupId, geometryIds, safetyIntent })
    default:
      return minimalEnvelopeIntent(type, options)
  }
}

/** Families whose builder needs evidence a fixture cannot invent (chamfer's
 * selected edges) get the smallest envelope the AUTHORITY accepts; their
 * resolver will still refuse at compute, truthfully, for want of features. */
function minimalEnvelopeIntent(
  type: OperationType,
  options: SmartHeightAuthorityFixtureOptions,
): OperationHeightIntentV2 {
  const variant = defaultSmartHeightVariant(type)
  const setupOwner: SmartHeightIntentOwner = { kind: 'setup', setupId: options.setupId ?? 'setup-1' }
  const policyOwner: SmartHeightIntentOwner = { kind: 'operation_policy' }
  const heights = options.heights ?? {}
  const plane = (
    reference: AuthoredPlaneIntentV2['reference'],
    offsetMm: number,
  ): AuthoredPlaneIntentV2 => ({ reference, offsetMm, owner: setupOwner })
  const start: MaterialStartIntent = { kind: 'policy_default' }
  const end: MachiningEndIntent = { kind: 'policy_default' }
  const scope: MachiningScopeIntent = { kind: 'selected_geometry', geometryIds: scopeGeometryIds(options) }
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: type, variant } as OperationHeightPolicyIntent,
    safety: {
      clearance: plane('retract', heights.clearanceHeight ?? 5),
      retract: plane('stock_top', heights.retractHeight ?? 5),
      feed: plane('top', heights.feedHeight ?? 5),
    },
    machining: {
      start: { value: start, owner: policyOwner },
      end: { value: end, owner: policyOwner },
      scope: { value: scope, owner: policyOwner },
    },
  }
}

/** The persisted envelope an operation fixture assigns to `smartHeight`. */
export function smartHeightAuthorityFixture(
  type: OperationType,
  options: SmartHeightAuthorityFixtureOptions = {},
): PersistedOperationHeightState {
  return { kind: 'smart_v2', intent: smartHeightIntentFixture(type, options) }
}

/** Convenience for fixtures that already have the operation in hand: reads
 * type, heights and params off it. */
export function stampSmartHeightAuthority<T extends Pick<Operation, 'type' | 'heights' | 'params'>>(
  op: T,
  options: Omit<SmartHeightAuthorityFixtureOptions, 'heights' | 'params'> = {},
): T & { smartHeight: PersistedOperationHeightState } {
  return {
    ...op,
    smartHeight: smartHeightAuthorityFixture(op.type, {
      ...options,
      heights: op.heights,
      params: op.params as Record<string, unknown>,
    }),
  }
}
