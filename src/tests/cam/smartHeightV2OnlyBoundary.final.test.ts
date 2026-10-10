import { describe, expect, it } from 'vitest'
import type {
  HeightEvidenceContext,
  OperationHeightIntentV2,
  SmartHeightEvidenceKind,
  SmartHeightEvidenceNode,
  SmartHeightEvidenceRole,
} from '../../lib/cam/smartHeights'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  resolveSmartHeightPlan,
} from '../../lib/cam/smartHeights'

const node = (
  id: string,
  kind: SmartHeightEvidenceKind,
  role: SmartHeightEvidenceRole,
  valueMm?: number,
): SmartHeightEvidenceNode => ({
  id,
  kind,
  role,
  entityId: `${kind}:${id}`,
  dependencyNodeIds: [],
  dependencyFingerprint: `fp:${id}`,
  ...(valueMm === undefined ? {} : { scalar: { frame: 'wcs', valueMm } as const }),
})

function liveFaceIntent(): OperationHeightIntentV2 {
  const setupOwner = { kind: 'setup' as const, setupId: 'setup-live' }
  const policyOwner = { kind: 'operation_policy' as const }
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'face', variant: 'target_face' },
    safety: {
      clearance: { reference: 'retract', offsetMm: 10, owner: setupOwner },
      retract: { reference: 'stock_top', offsetMm: 5, owner: setupOwner },
      feed: { reference: 'top', offsetMm: 2, owner: setupOwner },
    },
    machining: {
      start: { value: { kind: 'policy_default' }, owner: policyOwner },
      end: { value: { kind: 'policy_default' }, owner: policyOwner },
      scope: {
        value: { kind: 'selected_geometry', geometryIds: ['part-live'] },
        owner: policyOwner,
      },
    },
  }
}

function liveFaceContext(): HeightEvidenceContext {
  return {
    revision: {
      projectRevision: 'project-live',
      setupRevision: 'setup-live',
      operationRevision: 'operation-live',
    },
    operationType: 'face',
    wcsOriginMachineMm: 100,
    evidence: [
      node('stock-top', 'owning_stock', 'stock_top', 10),
      node('target-model', 'target_model', 'target_top', 8),
      node('target-face', 'selected_plane', 'selected_plane', 7),
      node('scope', 'operation_scope', 'scope'),
    ],
  }
}

describe('Smart Height V2-only public boundary', () => {
  it('fails loudly when a V1-shaped payload reaches the V2 resolver', () => {
    const oldPayload = {
      version: 1,
      policyVersion: 0,
      policy: { operationType: 'face', variant: 'target_face' },
      clearanceHeight: 999,
      retractHeight: 998,
      topHeight: 997,
      bottomHeight: 996,
    } as unknown as OperationHeightIntentV2

    expect(resolveSmartHeightPlan(oldPayload, liveFaceContext())).toMatchObject({
      ok: false,
      refusal: {
        code: 'policy_version_unsupported',
      },
    })
  })

  it('keeps a valid V2 operation resolvable beside a refused old operation', () => {
    const valid = resolveSmartHeightPlan(liveFaceIntent(), liveFaceContext())
    const old = resolveSmartHeightPlan({
      ...liveFaceIntent(),
      version: 1,
      policyVersion: 0,
    } as unknown as OperationHeightIntentV2, liveFaceContext())

    expect(valid).toMatchObject({
      ok: true,
      plan: {
        version: 2,
        machining: { cutterCenterEnd: { wcsMm: 7, machineMm: 107 } },
      },
    })
    expect(old).toMatchObject({
      ok: false,
      refusal: { code: 'policy_version_unsupported' },
    })
  })

  it('derives runtime truth only from V2 intent and evidence, not poisoned scalar mirrors', () => {
    const intent = Object.assign(liveFaceIntent(), {
      heights: {
        clearanceHeight: -500,
        retractHeight: -600,
        feedHeight: -700,
        topHeight: -800,
        bottomHeight: -900,
      },
      heightSource: 'setup',
      resolvedHeights: {
        version: 1,
        machine: { clearance: 900, retract: 800, feed: 700, top: 600, bottom: 500 },
      },
    })
    const context = Object.assign(liveFaceContext(), {
      legacyHeightParams: {
        clearanceHeight: 5000,
        retractHeight: 4000,
        feedHeight: 3000,
        topHeight: 2000,
        bottomHeight: 1000,
      },
    })

    const result = resolveSmartHeightPlan(intent, context)
    expect(result).toMatchObject({
      ok: true,
      plan: {
        safety: {
          clearance: { wcsMm: 25, machineMm: 125 },
          retract: { wcsMm: 15, machineMm: 115 },
          feed: { wcsMm: 12, machineMm: 112 },
        },
        machining: {
          materialStart: { wcsMm: 10, machineMm: 110 },
          cutterCenterEnd: { wcsMm: 7, machineMm: 107 },
        },
      },
    })
  })
})
