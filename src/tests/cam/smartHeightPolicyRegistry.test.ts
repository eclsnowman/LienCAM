import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { OperationType } from '../../types'
import {
  OPERATION_HEIGHT_POLICIES,
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  SMART_HEIGHT_RUNTIME_CONFORMANCE_MANIFEST,
  SMART_HEIGHT_FAMILY_ACTIVATION_GATES,
  SMART_HEIGHT_VARIANT_ACTIVATION_GATES,
  operationHeightPolicy,
  resolveSmartHeightPlan,
  type OperationHeightIntentV2,
} from '../../lib/cam/smartHeights'

const declaredTypes = Object.keys(OPERATION_HEIGHT_POLICIES) as OperationType[]

describe('Smart Height V2 operation policy registry', () => {
  it('is exhaustive and preserves the audited live/unsupported boundary', () => {
    expect(declaredTypes).toHaveLength(16)
    // WO-1196 wired the final union member: every declared family is live.
    expect(declaredTypes.map(type => operationHeightPolicy(type).support)).toEqual(Array(16).fill('live'))
  })

  it.each(declaredTypes)('%s has internally named variants and conformance fixtures', (operationType) => {
    const policy = operationHeightPolicy(operationType)
    expect(policy.operationType).toBe(operationType)
    const variants = Object.entries(policy.variants)
    expect(variants.length).toBeGreaterThan(0)
    for (const [name, variant] of variants) {
      expect(name).not.toBe('')
      expect(['live', 'provisional', 'unavailable', 'unsupported'])
        .toContain(variant.activation.status)
      expect(variant.conformanceFixtures.length).toBeGreaterThan(0)
      expect(new Set(variant.conformanceFixtures).size).toBe(variant.conformanceFixtures.length)
      expect(variant.endpointCardinality).not.toBe('unsupported')
      expect(variant.missingEvidence).not.toBe('unsupported')
    }
  })

  it('requires remaining material for explicit Adaptive rest machining', () => {
    const rest = OPERATION_HEIGHT_POLICIES.adaptive_3d.variants.rest
    expect(rest.materialStart).toBe('remaining_material_required')
    expect(rest.requiredEvidence).toContain('remaining_material')
    expect(rest.missingEvidence).toBe('refuse')
  })

  it('requires explicit confirmation where flat inputs contain no physical Z intent', () => {
    expect(OPERATION_HEIGHT_POLICIES.contour_2d.variants.explicit_depth.missingEvidence).toBe('require_explicit_confirmation')
    expect(OPERATION_HEIGHT_POLICIES.pocket_2d.variants.explicit_depth.missingEvidence).toBe('require_explicit_confirmation')
    expect(OPERATION_HEIGHT_POLICIES.adaptive_clearing_2d.variants.explicit_depth.missingEvidence).toBe('require_explicit_confirmation')
    expect(OPERATION_HEIGHT_POLICIES.drill.variants.explicit_depth.missingEvidence).toBe('require_explicit_confirmation')
    expect(OPERATION_HEIGHT_POLICIES.bore.variants.explicit_depth.missingEvidence).toBe('require_explicit_confirmation')
    expect(OPERATION_HEIGHT_POLICIES.face.variants.explicit_depth.missingEvidence).toBe('require_explicit_confirmation')
    expect(OPERATION_HEIGHT_POLICIES.engrave.variants.explicit_depth.missingEvidence).toBe('require_explicit_confirmation')
  })

  it('keeps physical target fields distinct from scalar operation endpoints', () => {
    expect(OPERATION_HEIGHT_POLICIES.adaptive_3d.variants.initial_stock.endpointCardinality).toBe('spatial_field')
    expect(OPERATION_HEIGHT_POLICIES.parallel_3d.variants.target_surface.endpointCardinality).toBe('spatial_field')
    expect(OPERATION_HEIGHT_POLICIES.steep_shallow_3d.variants.target_surface.endpointCardinality).toBe('spatial_field')
    expect(OPERATION_HEIGHT_POLICIES.scallop_3d.variants.target_surface.endpointCardinality).toBe('spatial_field')
    expect(OPERATION_HEIGHT_POLICIES.pencil_3d.variants.target_surface.endpointCardinality).toBe('spatial_field')
    expect(OPERATION_HEIGHT_POLICIES.drill.variants.detected_features.endpointCardinality).toBe('per_feature')
    expect(OPERATION_HEIGHT_POLICIES.bore.variants.detected_features.endpointCardinality).toBe('per_feature')
  })

  it('has one globally unique runtime conformance entry for every declared fixture', () => {
    const declaredFixtures = Object.values(OPERATION_HEIGHT_POLICIES).flatMap(policy =>
      Object.values(policy.variants).flatMap(variant => variant.conformanceFixtures),
    )
    expect(SMART_HEIGHT_RUNTIME_CONFORMANCE_MANIFEST.map(entry => entry.fixtureId).sort())
      .toEqual([...declaredFixtures].sort())
    expect(new Set(declaredFixtures).size).toBe(declaredFixtures.length)
  })

  it.each(declaredTypes)('%s family summary reflects its variant gates', (operationType) => {
    const policy = operationHeightPolicy(operationType)
    const gate = SMART_HEIGHT_FAMILY_ACTIVATION_GATES[operationType]
    expect(gate.operationType).toBe(operationType)
    const statuses = Object.values(policy.variants).map(variant => variant.activation.status)
    const expected = statuses.every(status => status === 'live') ? 'live' : 'partial'
    expect(gate.status).toBe(expected)
    if (gate.status !== 'live') expect(gate.reason?.trim()).not.toBe('')
  })

  it('requires all four direct proof files for every live variant only', () => {
    const declaredVariants = Object.values(OPERATION_HEIGHT_POLICIES)
      .flatMap(policy => Object.keys(policy.variants))
    expect(SMART_HEIGHT_VARIANT_ACTIVATION_GATES).toHaveLength(declaredVariants.length)

    for (const gate of SMART_HEIGHT_VARIANT_ACTIVATION_GATES) {
      if (gate.activation.status !== 'live') {
        expect(gate.proof).toBeUndefined()
        expect(gate.activation.reason.trim()).not.toBe('')
        continue
      }
      expect(gate.proof, `${gate.operationType}:${gate.variant} has no proof`).toBeDefined()
      for (const [layer, testPath] of Object.entries(gate.proof!)) {
        expect(testPath, `${gate.operationType}:${gate.variant} ${layer} proof must name a test file`)
          .toMatch(/^src\/tests\/.+\.test\.tsx?$/)
        expect(existsSync(resolve(testPath)), `${gate.operationType}:${gate.variant} ${layer} proof does not exist: ${testPath}`)
          .toBe(true)
      }
    }
  })

  const liveConformance = SMART_HEIGHT_RUNTIME_CONFORMANCE_MANIFEST.filter(entry =>
    entry.activation === 'live' || entry.activation === 'provisional',
  )

  it.each(liveConformance)(
    '$fixtureId routes through its registered resolver variant',
    ({ operationType, variant }) => {
      const owner = { kind: 'operation_policy' as const }
      const intent = {
        version: SMART_HEIGHT_INTENT_VERSION,
        policyVersion: SMART_HEIGHT_POLICY_VERSION,
        policy: { operationType, variant },
        safety: {
          clearance: { reference: 'wcs_plane', offsetMm: 15, owner },
          retract: { reference: 'wcs_plane', offsetMm: 10, owner },
          feed: { reference: 'wcs_plane', offsetMm: 7, owner },
        },
        machining: {
          start: { value: { kind: 'policy_default' }, owner },
          end: { value: { kind: 'policy_default' }, owner },
          scope: {
            value: { kind: 'selected_geometry', geometryIds: ['fixture-geometry'] },
            owner,
          },
        },
      } as OperationHeightIntentV2
      const result = resolveSmartHeightPlan(intent, {
        operationType,
        wcsOriginMachineMm: 0,
        revision: {
          projectRevision: 'fixture-project',
          setupRevision: 'fixture-setup',
          operationRevision: `fixture-operation:${operationType}:${variant}`,
        },
        evidence: [],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('missing_evidence')
      expect(result.refusal.code).not.toBe('policy_mismatch')
    },
  )

  const inactiveConformance = SMART_HEIGHT_RUNTIME_CONFORMANCE_MANIFEST.filter(entry =>
    entry.activation === 'unavailable',
  )

  it.each(inactiveConformance)(
    '$fixtureId refuses V2 resolution because the variant is $activation',
    ({ operationType, variant }) => {
      const owner = { kind: 'operation_policy' as const }
      const intent = {
        version: SMART_HEIGHT_INTENT_VERSION,
        policyVersion: SMART_HEIGHT_POLICY_VERSION,
        policy: { operationType, variant },
        safety: {
          clearance: { reference: 'wcs_plane', offsetMm: 15, owner },
          retract: { reference: 'wcs_plane', offsetMm: 10, owner },
          feed: { reference: 'wcs_plane', offsetMm: 7, owner },
        },
        machining: {
          start: { value: { kind: 'policy_default' }, owner },
          end: { value: { kind: 'policy_default' }, owner },
          scope: {
            value: { kind: 'selected_geometry', geometryIds: ['fixture-geometry'] },
            owner,
          },
        },
      } as OperationHeightIntentV2
      expect(resolveSmartHeightPlan(intent, {
        operationType,
        wcsOriginMachineMm: 0,
        revision: {
          projectRevision: 'fixture-project',
          setupRevision: 'fixture-setup',
          operationRevision: `fixture-operation:${operationType}:${variant}`,
        },
        evidence: [],
      })).toMatchObject({ ok: false, refusal: { code: 'inactive_variant' } })
    },
  )
})
