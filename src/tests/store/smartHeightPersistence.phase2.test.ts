import { describe, expect, it } from 'vitest'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  buildPlanarRoughSmartHeightIntent,
  ensureOperationSmartHeightAuthority,
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  SmartHeightPersistenceError,
  validatePersistedSmartHeightState,
} from '../../lib/cam/smartHeights'
import { useCamStore } from '../../store'
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  migrateProjectData,
  migrateSmartHeightAuthority,
  projectMigrations,
} from '../../store/migrations/projectMigrations'
import { UnknownSchemaVersionError, runMigrationChain } from '../../store/migrations/schemaMigration'

const NEVER_WIRED_3D = '__never_wired_3d'

function operationRecord(id = 'adaptive-operation') {
  return {
    id,
    name: 'Existing Adaptive 3D',
    type: 'adaptive_3d',
    enabled: true,
    status: 'ready',
    toolId: 'tool-1',
    geometrySelections: ['geo-1'],
    heights: {
      clearanceHeight: 15,
      clearanceHeightMode: 'absolute',
      retractHeight: 10,
      feedHeight: 7,
      topHeight: 5,
      topHeightMode: 'stock_top',
      bottomHeight: -3,
      bottomHeightMode: 'absolute',
      heightIntent: defaultHeightIntent(),
    },
    resolvedHeights: {
      version: 1,
      wcs: { clearance: 15, retract: 10, feed: 7, top: 5, bottom: -3 },
      machine: { clearance: 115, retract: 110, feed: 107, top: 105, bottom: 97 },
      intent: defaultHeightIntent(),
      dependencyIds: ['setup-1', 'stock-1', 'geo-1', 'tool-1'],
    },
    generationFingerprint: 'generated-v1-fingerprint',
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: { entryType: 'plunge', rampAngle: 2, rampLength: 5 },
    params: {
      restMachining: true,
      referencePlaneGeo: { geometryId: 'geo-1', localZ: 5 },
      strategySentinel: { preserve: ['complete', 'v1', 'record'] },
    },
    toolpathMoves: [
      { type: 'rapid', x: 1, y: 2, z: 115 },
      { type: 'linear', x: 1, y: 2, z: 97, feed: 300 },
    ],
    computeTimeMs: 42,
    estimatedCutTimeMs: 1234,
  }
}

function projectWithOperations<T>(operations: T[], schemaVersion = 18) {
  return {
    schemaVersion,
    id: 'project-1',
    name: 'Smart Height migration fixture',
    setups: [{ id: 'setup-1', operations }],
  }
}

function validV2State() {
  const owner = { kind: 'operation_policy' as const }
  return {
    kind: 'smart_v2' as const,
    intent: {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'face' as const, variant: 'target_face' as const },
      safety: {
        clearance: { reference: 'wcs_plane' as const, offsetMm: 15, owner },
        retract: { reference: 'wcs_plane' as const, offsetMm: 10, owner },
        feed: { reference: 'wcs_plane' as const, offsetMm: 7, owner },
      },
      machining: {
        start: { value: { kind: 'policy_default' as const }, owner },
        end: { value: { kind: 'policy_default' as const }, owner },
        scope: {
          value: { kind: 'selected_geometry' as const, geometryIds: ['geo-1'] },
          owner,
        },
      },
    },
  }
}

describe('Smart Height V2-only persistence', () => {
  it('refuses a newly inserted live operation with no explicit V2 authority', () => {
    const operation = operationRecord('missing-v2')
    expect(() => ensureOperationSmartHeightAuthority(operation as any)).toThrowError(
      expect.objectContaining({ code: 'missing_live_authority' }),
    )
  })

  it('refuses unsupported families instead of creating compatibility authority', () => {
    const operation = { ...operationRecord('unsupported-operation'), type: NEVER_WIRED_3D }
    expect(() => ensureOperationSmartHeightAuthority(operation as any)).toThrowError(
      expect.objectContaining({ code: 'unsupported_operation' }),
    )
  })

  it('enforces explicit V2 authority at the central store insertion boundary', () => {
    useCamStore.setState(state => ({
      project: {
        ...state.project,
        activeOperationId: null,
        setups: [{ id: 'smart-height-setup', name: 'Smart Height', operations: [] }] as any,
      },
    }))
    expect(() => useCamStore.getState().addOperation(
      'smart-height-setup', operationRecord('store-missing-v2') as any,
    )).toThrowError(expect.objectContaining({ code: 'missing_live_authority' }))
    expect(useCamStore.getState().project.setups[0].operations).toHaveLength(0)
  })

  it('preserves valid V2 insertion authority and refuses corrupt or mismatched live tags', () => {
    const v2 = { ...operationRecord('new-v2'), type: 'face', smartHeight: validV2State() }
    expect(ensureOperationSmartHeightAuthority(v2 as any)).toBe(v2)
    expect(() => ensureOperationSmartHeightAuthority({
      ...operationRecord('corrupt'),
      smartHeight: { kind: 'future_height_system' },
    } as any)).toThrow(SmartHeightPersistenceError)
    expect(() => ensureOperationSmartHeightAuthority({
      ...operationRecord('mismatched'), type: 'adaptive_3d', smartHeight: validV2State(),
    } as any)).toThrowError(expect.objectContaining({ code: 'policy_operation_mismatch' }))
    expect(() => ensureOperationSmartHeightAuthority({
      ...operationRecord('unsupported-live'), type: NEVER_WIRED_3D, smartHeight: validV2State(),
    } as any)).toThrowError(expect.objectContaining({ code: 'unsupported_operation' }))
  })

  // WO-1969 implemented surface-following Engrave: the variant that used to be
  // the reserved, refused one is now accepted at insertion like its siblings.
  it.each([
    ['engrave', 'surface_following'],
  ] as const)('accepts implemented V2 variant %s:%s at insertion', (type, variant) => {
    const smartHeight = validV2State() as any
    smartHeight.intent.policy = { operationType: type, variant }
    const candidate = {
      ...operationRecord(`implemented-${type}-${variant}`),
      type,
      smartHeight,
    } as any
    expect(ensureOperationSmartHeightAuthority(candidate)).toBe(candidate)
  })

  it.each(['pocket_2d', 'adaptive_clearing_2d'] as const)(
    'accepts live %s geometry-floor authority at insertion',
    type => {
      const candidate = {
        ...operationRecord(`live-${type}-geometry-floor`),
        type,
        smartHeight: {
          kind: 'smart_v2' as const,
          intent: buildPlanarRoughSmartHeightIntent({
            setupId: 'setup-1',
            operationType: type,
            safetyIntent: defaultHeightIntent(),
            mode: 'geometry_floor',
            geometryIds: ['geo-1'],
          }),
        },
      }
      expect(ensureOperationSmartHeightAuthority(candidate as any)).toBe(candidate)
    },
  )

  it.each([
    ['pocket_2d', 'explicit_depth'],
    ['pocket_2d', 'through_stock'],
    ['adaptive_clearing_2d', 'explicit_depth'],
    ['adaptive_clearing_2d', 'through_stock'],
  ] as const)('accepts live %s %s authority at insertion', (type, mode) => {
    const candidate = {
      ...operationRecord(`live-${type}-${mode}`),
      type,
      smartHeight: {
        kind: 'smart_v2' as const,
        intent: buildPlanarRoughSmartHeightIntent({
          setupId: 'setup-1',
          operationType: type,
          safetyIntent: defaultHeightIntent(),
          mode,
          geometryIds: ['geo-1'],
          explicitTargetWcsMm: mode === 'explicit_depth' ? -3 : undefined,
          throughAllowanceMm: mode === 'through_stock' ? 0.5 : undefined,
        }),
      },
    }
    expect(ensureOperationSmartHeightAuthority(candidate as any)).toBe(candidate)
  })

  it('does not synthesize V2 authority for an existing operation', () => {
    const operation = operationRecord()
    const input = projectWithOperations([operation])
    expect(migrateSmartHeightAuthority(input)).toBe(input)
    expect(input.setups[0].operations[0]).not.toHaveProperty('smartHeight')
  })

  it('loads schema v18 without inventing authority and leaves re-authoring to the operation boundary', () => {
    const input = projectWithOperations([operationRecord()])
    const migrated = migrateProjectData(JSON.parse(JSON.stringify(input))) as any
    expect(CURRENT_PROJECT_SCHEMA_VERSION).toBe(19)
    expect(migrated.schemaVersion).toBe(19)
    expect(migrated.setups[0].operations[0]).not.toHaveProperty('smartHeight')

    const reopened = migrateProjectData(JSON.parse(JSON.stringify(migrated))) as any
    expect(reopened).toEqual(migrated)
  })

  it('preserves a valid V2 authority envelope on a current project', () => {
    const operation = { ...operationRecord('face-v2'), type: 'face', smartHeight: validV2State() }
    const current = projectWithOperations([operation], CURRENT_PROJECT_SCHEMA_VERSION)
    const reopened = migrateProjectData(JSON.parse(JSON.stringify(current))) as any
    expect(reopened).toEqual(current)
    expect(validatePersistedSmartHeightState(reopened.setups[0].operations[0].smartHeight).ok)
      .toBe(true)
  })

  it('makes a v18 build fail loud on the new authority semantics', () => {
    const current = migrateProjectData(projectWithOperations([operationRecord()]))
    expect(() => runMigrationChain(current, 19, 18, projectMigrations))
      .toThrow(UnknownSchemaVersionError)
  })

  it('loads current-schema operations without authority but refuses them at the operation boundary', () => {
    const missing = projectWithOperations(
      [operationRecord('missing-authority')],
      CURRENT_PROJECT_SCHEMA_VERSION,
    )
    const loaded = migrateProjectData(missing) as any
    expect(loaded.setups[0].operations[0]).not.toHaveProperty('smartHeight')
    expect(() => ensureOperationSmartHeightAuthority(loaded.setups[0].operations[0]))
      .toThrowError(expect.objectContaining({ code: 'missing_live_authority' }))

    const corrupt = projectWithOperations([{
      ...operationRecord('corrupt-authority'),
      smartHeight: { kind: 'smart_v2', intent: { version: 2, policyVersion: 99 } },
    }], CURRENT_PROJECT_SCHEMA_VERSION)
    const loadedCorrupt = migrateProjectData(corrupt) as any
    expect(() => ensureOperationSmartHeightAuthority(loadedCorrupt.setups[0].operations[0]))
      .toThrow(SmartHeightPersistenceError)
  })

  it('names corrupt envelopes and stale or unknown V2 policies', () => {
    expect(validatePersistedSmartHeightState(null)).toMatchObject({
      ok: false, code: 'invalid_envelope',
    })
    expect(validatePersistedSmartHeightState({
      kind: 'removed_compatibility_marker', resolverVersion: 1,
    })).toMatchObject({ ok: false, code: 'invalid_envelope' })
    expect(validatePersistedSmartHeightState({
      ...validV2State(),
      intent: { ...validV2State().intent, policyVersion: 99 },
    })).toMatchObject({ ok: false, code: 'unsupported_policy_version' })
    expect(validatePersistedSmartHeightState({
      ...validV2State(),
      intent: {
        ...validV2State().intent,
        policy: { operationType: 'face', variant: 'future_magic' },
      },
    })).toMatchObject({ ok: false, code: 'unknown_policy' })
  })

  it('is an identity migration for both missing and valid V2 authority', () => {
    const missing = operationRecord()
    const v2 = { ...operationRecord('v2'), type: 'face', smartHeight: validV2State() }
    const project = projectWithOperations([missing, v2])
    expect(migrateSmartHeightAuthority(project)).toBe(project)
  })
})
