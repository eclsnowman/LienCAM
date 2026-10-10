import { describe, expect, it } from 'vitest'
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  migratePocketOutsideInHelixEntry,
  migrateProjectData,
} from '../../store/migrations/projectMigrations'
import {
  PERSIST_STORE_VERSION,
  persistMigrate,
} from '../../store'
import { UnknownSchemaVersionError } from '../../store/migrations/schemaMigration'

function pocket(
  id: string,
  fillStrategy: string | undefined,
  entryType: string,
) {
  return {
    id,
    type: 'pocket_2d',
    params: fillStrategy === undefined ? {} : { fillStrategy },
    linking: { entryType, rampAngle: 3 },
  }
}

describe('Pocket outside-in entry migration', () => {
  it('converts explicit and implicit outside-in helices without touching other entries', () => {
    const explicit = pocket('explicit', 'outside_in', 'ramp_helical')
    const implicit = pocket('implicit', undefined, 'ramp_helical')
    const inside = pocket('inside', 'inside_out', 'ramp_helical')
    const plunge = pocket('plunge', 'outside_in', 'plunge')
    const unknown = pocket('unknown', 'future_strategy', 'ramp_helical')
    const input = {
      setups: [{ id: 'setup', operations: [explicit, implicit, inside, plunge, unknown] }],
    }

    const once = migratePocketOutsideInHelixEntry(input)
    const twice = migratePocketOutsideInHelixEntry(once)
    const operations = once.setups[0].operations

    expect(input.setups[0].operations[0].linking.entryType).toBe('ramp_helical')
    expect(operations.map((operation: any) => operation.linking.entryType)).toEqual([
      'ramp_linear',
      'ramp_linear',
      'ramp_helical',
      'plunge',
      'ramp_helical',
    ])
    expect(operations[0].linking.rampAngle).toBe(3)
    expect(operations[2]).toBe(inside)
    expect(operations[3]).toBe(plunge)
    expect(operations[4]).toBe(unknown)
    expect(twice).toBe(once)
  })

  it('appends the conversion at v9->v10 and remains idempotent at current schema', () => {
    const legacy = {
      schemaVersion: 9,
      setups: [{
        id: 'setup',
        operations: [pocket('legacy', 'outside_in', 'ramp_helical')],
      }],
    }

    const migrated = migrateProjectData(legacy)
    const repeated = migrateProjectData(migrated)

    // migrateProjectData always runs the FULL chain to CURRENT, not just the
    // v9->v10 step this test targets -- later steps (e.g. v10->v11 height
    // intent) are no-ops for a fixture with no `heights` on its operations, so
    // the schema stamp itself is asserted against the live constant rather
    // than a hardcoded number (this codebase's convention -- see
    // toolAngleMigration.test.ts, runtimeEstimateLoad.sim7.test.tsx).
    expect(migrated.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(migrated.setups[0].operations[0].linking.entryType).toBe('ramp_linear')
    expect(repeated).toEqual(migrated)
  })

  it('bumps the persisted wrapper so browser-saved schema-v9 projects run the conversion', () => {
    const persisted = {
      project: {
        schemaVersion: 9,
        geometry: [],
        stocks: [],
        setups: [{
          id: 'setup',
          operations: [pocket('persisted', undefined, 'ramp_helical')],
        }],
      },
    }

    const migrated = persistMigrate(persisted, 3) as typeof persisted

    expect(PERSIST_STORE_VERSION).toBe(6)
    expect(migrated.project.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(migrated.project.setups[0].operations[0].linking.entryType).toBe('ramp_linear')
  })

  it('still refuses projects newer than this build', () => {
    expect(() => migrateProjectData({
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION + 1,
    })).toThrow(UnknownSchemaVersionError)
  })
})
