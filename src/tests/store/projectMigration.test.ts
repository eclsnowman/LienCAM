// Project-document migration tests (ADR-0027).
// Builds a LEGACY (pre-schemaVersion) project fixture inline, mirroring the
// projectOpen.test.ts fixture style, and asserts migrateProjectData:
//  - populates the coordinate-hierarchy fields and stamps schemaVersion===CURRENT,
//  - is idempotent (a second pass is byte-identical),
//  - is behavior-equivalent at v1 to the old inline load path, and
//  - fails loud on a newer-than-supported document (ADR-0003).

import { describe, it, expect, vi } from 'vitest'
import {
  migrateProjectData,
  applySceneStockDefaults,
  CURRENT_PROJECT_SCHEMA_VERSION,
  MIGRATION_DEFAULT_SCENE_STOCK,
  projectMigrations,
  backfillChamferSetbackMarkers,
  migrateModelItemRegistry,
  migrateAdaptiveClearingAuthoredSemantics,
  migrateOpenContourEntryTruth,
  MIGRATION_LEGACY_MODEL_ITEM_ID,
  MIGRATION_LEGACY_MODEL_ITEM_NAME,
} from '../../store/migrations/projectMigrations'
import { planDimension } from '../../lib/sketch/tools/dimTool'
import {
  preR1ChamferSketch, incompleteRigSketch, buildPreR1ChamferRig, singlePinRigSketch,
} from './fixtures/preR1ChamferFixture'
import { migrateProjectToHierarchy } from '../../store/migrateHierarchy'
import { UnknownSchemaVersionError, runMigrationChain } from '../../store/migrations/schemaMigration'
import { useCamStore, defaultSceneStock } from '../../store'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import type {
  ImportedGeometry,
  Project,
  SceneStock,
  Setup,
  Loop2D,
} from '../../types'

// -- Legacy fixture (pre-hierarchy, pre-schemaVersion) ----------------------------

function makeDxfGeo(): ImportedGeometry {
  const loop: Loop2D = {
    id: 'loop-1',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    closed: true, type: 'contour', layerId: 'L1', area: 100,
  }
  // NOTE: deliberately NO stockId (legacy).
  return {
    id: 'geo-dxf', name: 'Plate', filename: 'plate.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [loop],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  }
}

function makeSetup(): Setup {
  // wcs has corner fields set but NO originBinding (legacy) -> migration derives
  // a stock_corner binding to the derived stock.
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      cornerRow: 0, cornerCol: 0, cornerFace: 'top',
    },
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 5, offsetY: 5, offsetZTop: 5, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [],
    notes: '',
  }
}

// A legacy sceneStock that carries an (empty) fixedStocks list.
const legacySceneStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function makeLegacyProject(): Project {
  // A valid Project WITHOUT stocks, geometry.stockId, or wcs.originBinding, and
  // WITHOUT schemaVersion (=> v0).
  return {
    id: 'proj-legacy', name: 'Legacy Project', version: '1.0.0',
    createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      axisLimits: {
        x: { maxCutting: 3000, maxRapid: 5000 },
        y: { maxCutting: 3000, maxRapid: 5000 },
        z: { maxCutting: 1000, maxRapid: 3000 },
      },
      notes: '',
    },
    toolLibrary: [], geometry: [makeDxfGeo()], setups: [makeSetup()],
    activeSetupId: null, activeOperationId: null,
    sceneStock: legacySceneStock, notes: '',
  }
}

describe('schema v18 open-contour entry truth migration', () => {
  const operation = (
    id: string,
    type: string,
    pathType: string,
    entryType: string,
  ) => ({
    id,
    name: id,
    type,
    enabled: true,
    status: 'outdated',
    toolId: 'tool-1',
    geometrySelections: [{ geometryId: 'geo-1', loopIds: ['loop-1'] }],
    heights: { topHeight: 0, bottomHeight: -2 },
    passes: { stepdown: 1 },
    linking: {
      entryType,
      rampAngle: 4,
      keepToolDown: true,
      customLinkingField: { preserve: ['exactly'] },
    },
    params: {
      pathType,
      side: 'left',
      direction: 'forward',
      customParamField: 17,
    },
    customOperationField: { preserve: true },
  })

  it('normalizes ramp_linear and every other non-plunge open-contour entry without mutating or disturbing sibling fields', () => {
    const rampLinear = operation('open-linear', 'contour_2d', 'open', 'ramp_linear')
    const rampHelical = operation('open-helical', 'contour_2d', 'open', 'ramp_helical')
    const arc = operation('open-arc', 'contour_2d', 'open', 'arc')
    const alreadyPlunge = operation('open-plunge', 'contour_2d', 'open', 'plunge')
    const closedRamp = operation('closed-ramp', 'contour_2d', 'closed', 'ramp_linear')
    const unrelated = operation('pocket-ramp', 'pocket_2d', 'open', 'ramp_linear')
    const input = {
      schemaVersion: 17,
      projectSentinel: { preserve: true },
      setups: [{
        id: 'setup-1',
        setupSentinel: ['preserve'],
        operations: [rampLinear, rampHelical, arc, alreadyPlunge, closedRamp, unrelated],
      }],
    }
    const before = JSON.parse(JSON.stringify(input))

    const out = migrateOpenContourEntryTruth(input)

    expect(input).toEqual(before)
    expect(out).not.toBe(input)
    expect(out.projectSentinel).toBe(input.projectSentinel)
    expect(out.setups[0].setupSentinel).toBe(input.setups[0].setupSentinel)
    for (const index of [0, 1, 2]) {
      expect(out.setups[0].operations[index]).toEqual({
        ...input.setups[0].operations[index],
        linking: {
          ...input.setups[0].operations[index].linking,
          entryType: 'plunge',
        },
      })
      expect(out.setups[0].operations[index].linking).not.toBe(
        input.setups[0].operations[index].linking,
      )
      expect(out.setups[0].operations[index].params).toBe(
        input.setups[0].operations[index].params,
      )
    }
    expect(out.setups[0].operations[3]).toBe(alreadyPlunge)
    expect(out.setups[0].operations[4]).toBe(closedRamp)
    expect(out.setups[0].operations[5]).toBe(unrelated)
    expect(migrateOpenContourEntryTruth(out)).toBe(out)
  })

  it('returns an already-plunge open contour, closed-contour ramp, and unrelated operation by identity', () => {
    const input = {
      schemaVersion: 17,
      setups: [{
        operations: [
          operation('open-plunge', 'contour_2d', 'open', 'plunge'),
          operation('closed-ramp', 'contour_2d', 'closed', 'ramp_linear'),
          operation('pocket-ramp', 'pocket_2d', 'open', 'ramp_linear'),
        ],
      }],
    }

    expect(migrateOpenContourEntryTruth(input)).toBe(input)
  })

  it('tolerates absent or malformed raw-document containers and safely materializes missing linking', () => {
    const malformed = {
      schemaVersion: 17,
      setups: [
        null,
        { operations: 'not-an-array' },
        {
          operations: [
            null,
            [],
            { type: 'contour_2d', params: null, linking: null },
            { type: 'contour_2d', params: { pathType: 'open' }, linking: 'not-an-object' },
          ],
        },
      ],
    }

    for (const raw of [null, 42, 'project', [], {}, { setups: null }]) {
      expect(() => migrateOpenContourEntryTruth(raw)).not.toThrow()
      expect(migrateOpenContourEntryTruth(raw)).toBe(raw)
    }
    expect(() => migrateOpenContourEntryTruth(malformed)).not.toThrow()
    const out = migrateOpenContourEntryTruth(malformed)
    expect(out.setups[2].operations[3].linking).toEqual({ entryType: 'plunge' })
  })

  it('runs v17 -> v18 through the real project chain and makes a v17 app fail loud', () => {
    const v17 = {
      schemaVersion: 17,
      setups: [{
        operations: [operation('open-ramp', 'contour_2d', 'open', 'ramp_linear')],
      }],
    }

    const v18 = {
      ...runMigrationChain(v17, 17, 18, projectMigrations),
      schemaVersion: 18,
    }
    expect(v18.schemaVersion).toBe(18)
    expect(v18.setups[0].operations[0].linking.entryType).toBe('plunge')
    expect(() => runMigrationChain(v18, 18, 17, projectMigrations))
      .toThrow(UnknownSchemaVersionError)
  })
})

describe('migrateProjectData (ADR-0027 project chain)', () => {
  it('v16 -> v17 claims authored Adaptive Clearing semantics with an identity transform', () => {
    const v16 = {
      ...migrateProjectData(makeLegacyProject()),
      schemaVersion: 16,
      setups: [{
        ...makeSetup(),
        operations: [{
          id: 'adaptive-authored',
          name: 'Adaptive Clearing',
          type: 'adaptive_clearing',
          enabled: true,
          status: 'outdated',
          toolId: 'tool-1',
          geometrySelections: [],
          heights: {},
          passes: {},
          linking: {},
          params: {
            minHelixRadius: 1.25,
            integralWallFollowLengthFactor: 2.5,
            climb: false,
          },
        }],
      }],
    }

    expect(migrateAdaptiveClearingAuthoredSemantics(v16)).toBe(v16)

    const out = migrateProjectData(JSON.parse(JSON.stringify(v16)))
    expect(out.schemaVersion).toBe(19)
    expect(out.setups[0].operations[0].params).toEqual(
      v16.setups[0].operations[0].params,
    )
  })

  it('v16 app refuses a v17 Adaptive Clearing semantics document', () => {
    const v17file = {
      ...migrateProjectData(makeLegacyProject()),
      schemaVersion: 17,
    }
    expect(v17file.schemaVersion).toBe(17)
    expect(() => runMigrationChain(v17file, 17, 16, projectMigrations))
      .toThrow(UnknownSchemaVersionError)
  })

  it('5. populates hierarchy fields and stamps schemaVersion===CURRENT', () => {
    const out = migrateProjectData(makeLegacyProject())
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    // stocks present (the derived stock at minimum)...
    expect(Array.isArray(out.stocks)).toBe(true)
    expect(out.stocks!.length).toBeGreaterThan(0)
    // ...every geometry has a stockId...
    expect(out.geometry.every((g) => typeof g.stockId === 'string')).toBe(true)
    // ...every setup wcs has an originBinding.
    expect(out.setups.every((s) => s.wcs.originBinding != null)).toBe(true)
  })

  it('6. is idempotent (second pass is byte-identical)', () => {
    const once = migrateProjectData(makeLegacyProject())
    const twice = migrateProjectData(migrateProjectData(makeLegacyProject()))
    expect(twice).toEqual(once)
  })

  it('7. reproduces the old inline load path PLUS the documented v3 fields', () => {
    const legacy = makeLegacyProject()
    const migrated = migrateProjectData(legacy)
    // Strip the new stamp; the rest must equal the OLD path's hierarchy result
    // augmented with the documented v3 additions (toolLibraries + holders). The
    // legacy fixture has an empty toolLibrary, so no tool gains a libraryId here.
    const { schemaVersion, ...withoutStamp } = migrated
    void schemaVersion
    const oldPath = migrateProjectToHierarchy(applySceneStockDefaults(legacy))
    const expected = {
      ...oldPath,
      setups: oldPath.setups.map((setup) => ({
        ...setup,
        defaultHeightIntent: defaultHeightIntent(),
      })),
      toolLibraries: [{ id: 'lib-default', name: 'My Tools' }],
      holders: [],
    }
    expect(withoutStamp).toEqual(expected)
  })

  it('8. fails loud on a newer-than-supported document', () => {
    const newer = { ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION + 1 }
    expect(() => migrateProjectData(newer)).toThrow(UnknownSchemaVersionError)
  })

  it('CAM-1: an op\'s modelReferences + degraded status survive the load path (v5 no-op round-trip)', () => {
    // The load path (loadProjectFromFile) routes a parsed document through
    // migrateProjectData. An additive optional field on Operation must round-trip
    // verbatim and the new 'degraded' status must not be stripped/rejected on load.
    // A file carrying these CAM model-reference semantics is a v5 document (WO
    // CAM-1-R1 finding 3); a CURRENT (v5) project re-migrates as a no-op. Build one
    // whose op carries both and assert they come back untouched.
    const proj = migrateProjectData(makeLegacyProject())
    const op = {
      id: 'op-mr', name: 'Boundary', type: 'contour_2d', enabled: true, status: 'degraded',
      toolId: 't', geometrySelections: [],
      modelReferences: [{ bodyId: 'B1', stableIds: ['f1', 'f2'], role: 'machining-boundary' }],
      modelReferenceNote: 'Referenced model geometry was removed: 1 reference lost on B1.',
      heights: {}, passes: {}, linking: {}, params: {}, toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
      smartHeight: { kind: 'frozen_v1', resolverVersion: 1 },
    }
    const withOp: Project = {
      ...proj,
      setups: [{ ...proj.setups[0], operations: [op as unknown as Setup['operations'][number]] }],
    }
    const out = migrateProjectData(withOp) // from===current => no-op transform
    const rt = out.setups[0].operations[0]
    expect(rt.status).toBe('degraded')
    expect(rt.modelReferences).toEqual([{ bodyId: 'B1', stableIds: ['f1', 'f2'], role: 'machining-boundary' }])
    expect(rt.modelReferenceNote).toContain('lost on B1')
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
  })

  it('12. v4->CURRENT stamps the schema through pure no-op semantic claims (no data added, none lost)', () => {
    // The v4->v5 step (migrateCamModelReferenceSemantics) exists ONLY to claim the
    // version for CAM model-reference semantics; v5->v6 similarly claims the
    // arcLength kind. v6->v7 (migrateRuntimeEstimateTruth) is also byte-stable when
    // no stale estimate exists, and v7->v8 claims the d1xd2 kind. WO INT-14's
    // v8->v9 (migrateEmbeddedModelingDocument) claims the version for the embedded
    // modeling document and is likewise an identity: a pre-v9 project has no model
    // to backfill, so `document` must not be materialized on it. v9->v10
    // (migratePocketOutsideInHelixEntry) and v10->v11 (migrateHeightIntentSemantics)
    // are no-ops here too: this fixture's operations array is empty, so neither
    // step has anything to touch. All these steps are identity (or no-op)
    // transforms for this fixture's older content, all the way to CURRENT.
    //
    // NOTE on what this case does and does NOT guard: the `v4` fixture below is
    // itself built by running migrateProjectData, so a step that ADDED a field
    // would add it to both sides and sail through the toEqual. Case 7 above (a
    // hand-built expectation) is what actually catches that, together with
    // int14ProjectDocument.test.ts's AC6 cases -- both were verified RED against a
    // non-identity v8->v9 step. This case pins the STAMP reaching CURRENT through
    // the whole chain; do not read more into it than that -- so the stamp itself
    // is asserted against the live CURRENT_PROJECT_SCHEMA_VERSION constant (this
    // codebase's convention for "reached current", not a hardcoded number that
    // would go stale on every future schema bump).
    const v4 = { ...migrateProjectData(makeLegacyProject()), schemaVersion: 4 }
    const out = migrateProjectData(v4 as unknown as Project)
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    const { schemaVersion: _a, ...currentNoStamp } = out
    const { schemaVersion: _b, ...v4NoStamp } = v4
    void _a; void _b
    expect(currentNoStamp).toEqual(v4NoStamp) // no field added, nothing moved
  })

  it('13. an older app (supports only up to v4) FAILS LOUD on the current file', () => {
    // The finding: an additive 'degraded'/modelReferences payload left at v4 would
    // load SILENTLY in an old build, which then ignores the B-rep dependency. With
    // the v5 bump the old build (whose CURRENT is 4) hits ADR-0027's refusal. Model
    // that old build by running the SAME registered chain with target=4 against a
    // v5 document -> from(5) > current(4) -> UnknownSchemaVersionError.
    const v5file = migrateProjectData(makeLegacyProject())
    expect(v5file.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    const OLD_APP_CURRENT = 4
    expect(() => runMigrationChain(v5file, v5file.schemaVersion!, OLD_APP_CURRENT, projectMigrations))
      .toThrow(UnknownSchemaVersionError)
  })

  it('14. a v4 file loads into the NEW app unchanged except the advancing version stamp', () => {
    // Backward direction of the same guarantee: a real v4 file (no CAM semantics)
    // opens cleanly in the current app; only schemaVersion advances, content verbatim.
    const v4 = { ...migrateProjectData(makeLegacyProject()), schemaVersion: 4 }
    const out = migrateProjectData(v4 as unknown as Project)
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect({ ...out, schemaVersion: 4 }).toEqual(v4)
  })

  it('9. the save snapshot carries schemaVersion===CURRENT', () => {
    // saveProjectToFile serializes a snapshot that spreads the store's project
    // then overrides schemaVersion. It triggers a DOM download (no return value),
    // so assert the contract directly: the store's default project is stamped,
    // and a project spread with the save override carries the current stamp.
    const project = useCamStore.getState().project
    expect(project.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    const snapshot = { ...project, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION }
    expect(snapshot.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
  })

  it('10. v2->v3 seeds the default library + backfills libraryId + empty holders', () => {
    // A v2 project (already past the angle migration) with two tools that have
    // NO libraryId and NO library/holder fields. After migration to v3 it must
    // gain the default library, both tools get libraryId='lib-default',
    // holders=[] and schemaVersion===3.
    const v2 = {
      ...makeLegacyProject(),
      schemaVersion: 2,
      toolLibrary: [
        { id: 'tool-a', name: 'Endmill A', type: 'flat', diameter: 6 },
        { id: 'tool-b', name: 'Endmill B', type: 'flat', diameter: 3 },
      ],
    }
    const out = migrateProjectData(v2 as unknown as Project)
    // Chain runs v2 -> v3 (libraries) -> v4 (binaries no-op), stamping CURRENT.
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(out.toolLibraries).toEqual([{ id: 'lib-default', name: 'My Tools' }])
    expect(out.toolLibrary.map((t) => t.libraryId)).toEqual([
      'lib-default',
      'lib-default',
    ])
    expect(out.holders).toEqual([])
  })

  it('11. v3->v4 stamps CURRENT, adds no binaries field, loses no data', () => {
    // A v3 project (already has libraries + holders) migrates to v4. The v4 step is
    // a pure no-op: `binaries` is populated at SAVE time, never backfilled on load,
    // so a v3 file must NOT gain an (empty) binaries field — and nothing else moves.
    const v3 = {
      ...migrateProjectData(makeLegacyProject()),
      schemaVersion: 3,
    }
    const out = migrateProjectData(v3 as unknown as Project)
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect('binaries' in out).toBe(false)
    // No data loss: stripping only the version stamp, v4 equals the v3 input.
    const { schemaVersion: _a, ...v4NoStamp } = out
    const { schemaVersion: _b, ...v3NoStamp } = v3
    void _a; void _b
    expect(v4NoStamp).toEqual(v3NoStamp)
  })

  it('15. v5->CURRENT preserves arcLength through the runtime-estimate and d1xd2 identity steps', () => {
    const current = migrateProjectData(makeLegacyProject())
    const arcLength = {
      id: 'arc-length-dim', kind: 'arcLength', entityId: 'seam-arc',
      driving: false, value: Math.PI * 7, labelAnchor: { x: 2, y: 3 },
    }
    const v5 = {
      ...current,
      schemaVersion: 5,
      geometry: current.geometry.map((geometry, index) => index === 0 ? {
        ...geometry,
        sketches: [{
          id: 'round-trip-sketch', layerId: 'layer-1',
          entities: [{
            id: 'seam-arc', kind: 'arc', construction: false,
            center: { x: 0, y: 0 }, radius: 7,
            startAngle: 3 * Math.PI / 2, endAngle: Math.PI / 2,
          }],
          constraints: [], dimensions: [arcLength], solveStatus: null,
        }],
      } : geometry),
    }
    const serialized = JSON.stringify(v5)
    // v5->v6 (arcLength claim) is an identity transform; v6->v7
    // (migrateRuntimeEstimateTruth) is a no-op here (no stale estimate on this
    // fixture); v7->v8 (d1xd2 claim) is ALSO an identity transform, so this
    // still exercises "arcLength survives untouched" even though
    // migrateProjectData now runs two steps further to CURRENT (v8).
    const out = migrateProjectData(JSON.parse(serialized))

    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(out.geometry[0].sketches?.[0].dimensions).toEqual([arcLength])
    expect(JSON.parse(JSON.stringify(out)).geometry[0].sketches[0].dimensions[0])
      .toEqual(arcLength)
    expect({ ...out, schemaVersion: 5 }).toEqual(v5)
  })

  it('16. a v5 app fails loud on a v6 arcLength document', () => {
    // Built directly at v6 (not through migrateProjectData, which now runs to
    // CURRENT=8) to keep testing this EXACT historical boundary.
    const v6file = {
      ...runMigrationChain(makeLegacyProject(), 0, 6, projectMigrations),
      schemaVersion: 6,
    }
    expect(v6file.schemaVersion).toBe(6)
    expect(() => runMigrationChain(v6file, 6, 5, projectMigrations))
      .toThrow(UnknownSchemaVersionError)
  })

  it('17. a v7 app fails loud on the CURRENT (v8) d1xd2 document', () => {
    // Same boundary one version later (UI-50C-R6 renumbering): an app whose
    // CURRENT is still 7 (predates d1xd2 -- v7 is the unrelated runtime-estimate
    // claim) refuses a v8 file rather than silently mishandling the unknown
    // two-valued dimension kind.
    const v8file = migrateProjectData(makeLegacyProject())
    expect(v8file.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(() => runMigrationChain(v8file, v8file.schemaVersion!, 7, projectMigrations))
      .toThrow(UnknownSchemaVersionError)
  })

  it('18. v6->CURRENT is identity for an existing d1xd2 dimension (survives JSON serialization round-trip)', () => {
    const current = migrateProjectData(makeLegacyProject())
    const d1xd2 = {
      id: 'chamfer-setback-dim', kind: 'd1xd2', entityId: 'chamfer-line',
      driving: false, value: 3.5, d2: 4.25, labelAnchor: { x: 1, y: 2 },
    }
    const v6 = {
      ...current,
      schemaVersion: 6,
      geometry: current.geometry.map((geometry, index) => index === 0 ? {
        ...geometry,
        sketches: [{
          id: 'd1xd2-round-trip-sketch', layerId: 'layer-1',
          entities: [{
            id: 'chamfer-line', kind: 'line', construction: false,
            start: { x: 0, y: 0 }, end: { x: 3.5, y: 4.25 },
          }],
          constraints: [], dimensions: [d1xd2], solveStatus: null,
        }],
      } : geometry),
    }
    const serialized = JSON.stringify(v6)
    const out = migrateProjectData(JSON.parse(serialized))

    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(out.geometry[0].sketches?.[0].dimensions).toEqual([d1xd2])
    expect(JSON.parse(JSON.stringify(out)).geometry[0].sketches[0].dimensions[0])
      .toEqual(d1xd2)
    expect({ ...out, schemaVersion: 6 }).toEqual(v6)
  })

  // ---- WO-1858: a d1xd2 loads EXACTLY as it was saved, driving or not ----
  //
  // UI-50C-R1 forced every persisted d1xd2 back to driving:false at this
  // boundary, because the kind could not drive the solver. It can now, so the
  // pass is gone and its four tests are retired (ADR-0040: retired, never
  // migrated around). What replaces them is the statement that actually
  // matters to a saved file: a driving setback pair survives the round trip.

  function makeD1xd2Sketch(driving: boolean) {
    return {
      id: 'd1xd2-driving-sketch', layerId: 'layer-1',
      entities: [{
        id: 'chamfer-line', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 3, y: 4 },
      }],
      constraints: [],
      dimensions: [{
        id: 'forged-driving-readout', kind: 'd1xd2', entityId: 'chamfer-line',
        driving, value: 111, d2: 222,
      }],
      solveStatus: null,
    }
  }

  it('19. a DRIVING d1xd2 saved at the CURRENT schema loads back driving, untouched', () => {
    const current = migrateProjectData(makeLegacyProject())
    const alreadyV8 = {
      ...current,
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      geometry: current.geometry.map((geometry, index) => index === 0
        ? { ...geometry, sketches: [makeD1xd2Sketch(true)] } : geometry),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = migrateProjectData(alreadyV8)
      expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
      expect(out.geometry[0].sketches?.[0].dimensions[0]).toEqual({
        id: 'forged-driving-readout', kind: 'd1xd2', entityId: 'chamfer-line',
        driving: true, value: 111, d2: 222,
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('20. the same is true through a genuine v6 -> CURRENT migration', () => {
    const current = migrateProjectData(makeLegacyProject())
    const v6WithDrivingD1xd2 = {
      ...current,
      schemaVersion: 6,
      geometry: current.geometry.map((geometry, index) => index === 0
        ? { ...geometry, sketches: [makeD1xd2Sketch(true)] } : geometry),
    }
    const out = migrateProjectData(v6WithDrivingD1xd2)
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    const dim = out.geometry[0].sketches?.[0].dimensions[0] as { driving: boolean }
    expect(dim.driving).toBe(true)
  })

  it('21. a document with driving:false ALREADY correct triggers no spurious warning', () => {
    const current = migrateProjectData(makeLegacyProject())
    const clean = {
      ...current,
      geometry: current.geometry.map((geometry, index) => index === 0
        ? { ...geometry, sketches: [makeD1xd2Sketch(false)] } : geometry),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = migrateProjectData(clean)
      const dim = out.geometry[0].sketches?.[0].dimensions[0] as { driving: boolean; value: number; d2: number }
      expect(dim).toEqual({ id: 'forged-driving-readout', kind: 'd1xd2', entityId: 'chamfer-line',
        driving: false, value: 111, d2: 222 })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('drift guard: the migration module replica equals the store default', () => {
    // projectMigrations.ts replicates defaultSceneStock locally to stay free of
    // store-internal imports (avoiding a circular dependency). This assertion is
    // the safety net so the two copies can never silently drift apart.
    expect(MIGRATION_DEFAULT_SCENE_STOCK).toEqual(defaultSceneStock)
  })
})

// ---- INT-17C Stage C1 step 7: migrateModelItemRegistry (v11 -> v12) --------------
// Pure-function unit coverage for the migration step itself (the fixture-based
// hash-equality acceptance test lives in int17cC1FixtureBaseline.test.ts, which
// drives the SAME function through the real load path against a real save).

describe('INT-17C Stage C1 step 7: migrateModelItemRegistry (v11 -> v12, keyed Model Item registry)', () => {
  it('drift guard: the migration module replica equals documentHolder.LEGACY_MODEL_ITEM_ID', async () => {
    // migrateModelItemRegistry replicates LEGACY_MODEL_ITEM_ID locally (the SAME
    // "stay free of store-internal imports" precedent MIGRATION_DEFAULT_SCENE_STOCK
    // follows above) -- this is that pattern's safety net for THIS constant.
    const { LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')
    expect(MIGRATION_LEGACY_MODEL_ITEM_ID).toBe(LEGACY_MODEL_ITEM_ID)
  })

  it('a genuine v11 file with NO document is returned byte-stable (the common case: no-op, claims the version)', () => {
    const p = { schemaVersion: 11, geometry: [{ id: 'g1', format: 'stl' }] }
    expect(migrateModelItemRegistry(p)).toBe(p)
  })

  it('a document that is an empty string is treated as absent (byte-stable, no legacy item minted)', () => {
    const p = { schemaVersion: 11, document: '', geometry: [] }
    expect(migrateModelItemRegistry(p)).toBe(p)
  })

  it('wraps a populated document as one legacy Model Item, tags unclaimed model rows, backfills body-filtered Placements', () => {
    const p = {
      schemaVersion: 11,
      document: 'QUJDRA==', // arbitrary non-empty base64 stand-in; migrateModelItemRegistry never decodes it
      geometry: [
        { id: 'g-stl', format: 'stl' }, // non-model row: untouched
        {
          id: 'modelbody:b1', format: 'model', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 },
          modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
        },
        {
          id: 'modelbody:b2', format: 'model', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
          modelBody: { ref: { bodyId: 'b2', stableIds: ['b2:F0'], version: 1 } },
        },
      ],
    }
    const out = migrateModelItemRegistry(p)

    expect(out.document).toBe('QUJDRA==') // NOT deleted (deliberate deviation, see the function's own doc comment)
    expect(out.modelItems).toEqual([
      { id: MIGRATION_LEGACY_MODEL_ITEM_ID, name: MIGRATION_LEGACY_MODEL_ITEM_NAME },
    ])
    expect(out.geometry[0]).toBe(p.geometry[0]) // non-model row untouched, same reference
    expect(out.geometry[1].modelItemId).toBe(MIGRATION_LEGACY_MODEL_ITEM_ID)
    expect(out.geometry[2].modelItemId).toBe(MIGRATION_LEGACY_MODEL_ITEM_ID)
    expect(out.modelItemPlacements).toEqual([
      { modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID, bodyId: 'b1', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 } },
      { modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID, bodyId: 'b2', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
  })

  it('preserves a pre-existing modelItems array (appends the legacy entry alongside, never clobbers)', () => {
    const p = {
      schemaVersion: 11,
      document: 'QUJDRA==',
      modelItems: [{ id: 'user-created-1', name: 'Model Item 1' }],
      geometry: [],
    }
    const out = migrateModelItemRegistry(p)
    expect(out.modelItems).toEqual([
      { id: 'user-created-1', name: 'Model Item 1' },
      { id: MIGRATION_LEGACY_MODEL_ITEM_ID, name: MIGRATION_LEGACY_MODEL_ITEM_NAME },
    ])
  })

  it('is IDEMPOTENT: re-running on its own output is byte-stable (double-run safe)', () => {
    const p = {
      schemaVersion: 11,
      document: 'QUJDRA==',
      geometry: [{
        id: 'modelbody:b1', format: 'model', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 },
        modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
      }],
    }
    const once = migrateModelItemRegistry(p)
    const twice = migrateModelItemRegistry(once)
    expect(twice).toBe(once) // already-wrapped -> the `alreadyWrapped` guard short-circuits to the SAME reference
  })

  it('a model row already tagged with a modelItemId is left untouched (no double-Placement)', () => {
    const p = {
      schemaVersion: 11,
      document: 'QUJDRA==',
      geometry: [{
        id: 'modelbody:b1', format: 'model', modelItemId: 'some-other-item',
        position: { x: 5, y: 5, z: 5 }, rotation: { x: 0, y: 0, z: 0 },
        modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
      }],
    }
    const out = migrateModelItemRegistry(p)
    expect(out.geometry[0].modelItemId).toBe('some-other-item') // untouched
    expect(out.modelItemPlacements).toEqual([]) // nothing to backfill for an already-claimed row
  })

  it('end-to-end through the real chain: a v11 project with a document + a model row migrates to v12', () => {
    const legacy: any = {
      ...makeLegacyProject(),
      schemaVersion: 11,
      document: 'QUJDRA==',
      geometry: [
        ...makeLegacyProject().geometry,
        {
          id: 'modelbody:b1', name: 'Bracket', filename: 'Bracket', type: 'model', format: 'model',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
          modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
        },
      ],
    }
    const out = migrateProjectData(legacy)
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(out.modelItems).toEqual([
      {
        id: MIGRATION_LEGACY_MODEL_ITEM_ID,
        name: MIGRATION_LEGACY_MODEL_ITEM_NAME,
        documentState: 'authored',
      },
    ])
    const b1 = out.geometry.find((g) => g.id === 'modelbody:b1') as any
    expect(b1.modelItemId).toBe(MIGRATION_LEGACY_MODEL_ITEM_ID)
    expect(out.modelItemPlacements).toEqual([
      { modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID, bodyId: 'b1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
  })
})

// ---- INT-MODEL-UNIFY: migrateProjectData's unconditional load-boundary --------
// catch-up wrap. migrateModelItemRegistry's v12 STEP only fires while
// CROSSING v11->v12; a project that reached v12 by any other route (modeled
// in-app through the plain Model tab before this fix existed, then saved)
// never ran it, so its legacy-scoped model rows stayed unclaimed on every
// subsequent load -- Operator's exact repro, reloaded. Mirrors the SAME
// unconditional-load-boundary precedent backfillChamferSetbackMarkers
// already uses immediately above in migrateProjectData (see that function's
// own doc comment).

describe('INT-MODEL-UNIFY: migrateProjectData unconditionally catches up an unclaimed legacy model row on every load', () => {
  it('a v12 project (schemaVersion already CURRENT) with a document + an unclaimed legacy model row, and NO modelItems entry at all, gets claimed on load', () => {
    const v12: any = {
      ...makeLegacyProject(),
      schemaVersion: 12,
      document: 'QUJDRA==',
      geometry: [
        ...makeLegacyProject().geometry,
        {
          id: 'modelbody:b1', name: 'Extrude F1', filename: 'Extrude F1', type: 'model', format: 'model',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
          modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
        },
      ],
      // No `modelItems` field at all -- the exact shape a project saved
      // under the pre-fix bug carries.
    }
    const out = migrateProjectData(v12)
    // schemaVersion is stamped to CURRENT (v12 -> v13 is an additive identity
    // claim); the model-row claim below is the unconditional catch-up sweep,
    // which is what this test actually exercises.
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(out.modelItems).toEqual([
      {
        id: MIGRATION_LEGACY_MODEL_ITEM_ID,
        name: MIGRATION_LEGACY_MODEL_ITEM_NAME,
        documentState: 'authored',
      },
    ])
    const b1 = out.geometry.find((g) => g.id === 'modelbody:b1') as any
    expect(b1.modelItemId).toBe(MIGRATION_LEGACY_MODEL_ITEM_ID)
    expect(out.modelItemPlacements).toEqual([
      { modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID, bodyId: 'b1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
  })

  it('a v12 project already correctly wrapped (legacy claimed) is returned byte-stable for the modelItems/geometry/placements shape (no double-wrap)', () => {
    const v12: any = {
      ...makeLegacyProject(),
      schemaVersion: 12,
      document: 'QUJDRA==',
      modelItems: [{ id: MIGRATION_LEGACY_MODEL_ITEM_ID, name: MIGRATION_LEGACY_MODEL_ITEM_NAME }],
      geometry: [
        ...makeLegacyProject().geometry,
        {
          id: 'modelbody:b1', name: 'Extrude F1', filename: 'Extrude F1', type: 'model', format: 'model',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
          modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID,
          modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
        },
      ],
      modelItemPlacements: [
        { modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID, bodyId: 'b1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      ],
    }
    const out = migrateProjectData(v12)
    expect(out.modelItems).toEqual(
      v12.modelItems.map((item: any) => ({ ...item, documentState: 'authored' })),
    )
    expect(out.geometry).toEqual(v12.geometry)
    expect(out.modelItemPlacements).toEqual(v12.modelItemPlacements)
  })

  it('a v11 file (the ordinary migration path) migrates up to CURRENT, unchanged by the catch-up sweep -- the sweep is a true no-op layered on top', () => {
    const legacy: any = {
      ...makeLegacyProject(),
      schemaVersion: 11,
      document: 'QUJDRA==',
      geometry: [
        ...makeLegacyProject().geometry,
        {
          id: 'modelbody:b1', name: 'Bracket', filename: 'Bracket', type: 'model', format: 'model',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
          modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
        },
      ],
    }
    const out = migrateProjectData(legacy)
    expect(out.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(out.modelItems).toEqual([
      {
        id: MIGRATION_LEGACY_MODEL_ITEM_ID,
        name: MIGRATION_LEGACY_MODEL_ITEM_NAME,
        documentState: 'authored',
      },
    ])
  })

  it('a v12 (or any) project with NO document at all is untouched (nothing to claim)', () => {
    const p: any = { ...makeLegacyProject(), schemaVersion: 12 }
    const out = migrateProjectData(p)
    expect(out.modelItems ?? []).toEqual([])
  })
})

// ---- GEO-UNIFY Stage 2: ModelItemRecord.folderId (plan sec 5) -----------------
// An optional presentational field, NO schema bump (mirrors the geometryFolders
// precedent, types/index.ts:1286-1288 comment). No migration step reads or
// writes it, so a project saved before Stage 2 shipped -- whose modelItems
// entries carry no `folderId` key at all -- must load with the field simply
// absent (reads `undefined`, the tree treats that as "root") and every OTHER
// field byte-stable, exactly like any other untouched optional field riding
// through the project spread.

describe('GEO-UNIFY Stage 2: ModelItemRecord.folderId rides through migration untouched', () => {
  it('an older v12 project whose modelItems entries have NO folderId key loads with it simply absent (root)', () => {
    const v12: any = {
      ...makeLegacyProject(),
      schemaVersion: 12,
      document: 'QUJDRA==',
      modelItems: [{ id: MIGRATION_LEGACY_MODEL_ITEM_ID, name: MIGRATION_LEGACY_MODEL_ITEM_NAME }],
      geometry: [
        ...makeLegacyProject().geometry,
        {
          id: 'modelbody:b1', name: 'Extrude F1', filename: 'Extrude F1', type: 'model', format: 'model',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
          modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID,
          modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
        },
      ],
      modelItemPlacements: [
        { modelItemId: MIGRATION_LEGACY_MODEL_ITEM_ID, bodyId: 'b1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      ],
    }
    const out = migrateProjectData(v12)
    // v15 adds only the lightweight authored-document marker; folder identity
    // remains byte-stable and no geometry/placement is touched.
    expect(out.modelItems).toEqual(
      v12.modelItems.map((item: any) => ({ ...item, documentState: 'authored' })),
    )
    expect('folderId' in out.modelItems![0]).toBe(false)
    expect(out.modelItems![0].folderId).toBeUndefined()
    expect(out.geometry).toEqual(v12.geometry)
    expect(out.modelItemPlacements).toEqual(v12.modelItemPlacements)
  })

  it('a project WITH folderId already set on a modelItems entry (post-Stage-2 save) round-trips byte-stable', () => {
    const v12: any = {
      ...makeLegacyProject(),
      schemaVersion: 12,
      document: 'QUJDRA==',
      modelItems: [
        { id: 'user-item-1', name: 'Bracket', folderId: 'fld-1' },
        { id: MIGRATION_LEGACY_MODEL_ITEM_ID, name: MIGRATION_LEGACY_MODEL_ITEM_NAME, folderId: null },
      ],
      geometry: [],
    }
    const out = migrateProjectData(v12)
    expect(out.modelItems).toEqual([
      { ...v12.modelItems[0], documentState: 'unknown' },
      { ...v12.modelItems[1], documentState: 'authored' },
    ])
    expect(out.modelItems![0].folderId).toBe('fld-1')
    expect(out.modelItems![1].folderId).toBeNull()
  })
})

// ---- UI-50C-R2: chamferSetback identity BACKFILL (DECISIONS 2026-07-16 STOP requirement 3, -------
// preflight section 4's 9-case enumeration, edit 5). The R1 re-audit's MAJOR A: "a genuine pre-R1
// SKC-41A tool-built chamfer with the complete construction-phantom rig is therefore treated as an
// ordinary line and receives its hypotenuse distance." Cases (a)-(i) below are the preflight's exact
// enumeration; each is its own test so a future regression names the SPECIFIC case, not just "backfill
// broke somehow".

function grafted(project: ReturnType<typeof migrateProjectData>, sketch: unknown, schemaVersion?: number) {
  return {
    ...project,
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    geometry: project.geometry.map((g, i) => (i === 0 ? { ...g, sketches: [sketch] } : g)),
  }
}

describe('UI-50C-R2: backfillChamferSetbackMarkers (chamferSetback identity, load boundary)', () => {
  it('(a) unmarked COMPLETE valid rig, v6 -> BACKFILLED to chamferSetback:true', () => {
    const current = migrateProjectData(makeLegacyProject())
    const rig = preR1ChamferSketch(3)
    const v6 = grafted(current, rig, 6)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = migrateProjectData(v6)
      const line = out.geometry[0].sketches?.[0].entities.find((e: any) => e.id === rig.chamferLineId)
      expect((line as any).chamferSetback).toBe(true)
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls.find((c) => String(c[0]).includes(rig.chamferLineId))?.[0]))
        .toContain(rig.chamferLineId)
    } finally {
      warn.mockRestore()
    }
  })

  it('(a2) end-to-end: after backfill, planDimension resolves d1xd2 on the legacy line -- the hypotenuse case is DEAD', () => {
    const current = migrateProjectData(makeLegacyProject())
    const rig = preR1ChamferSketch(3)
    const v6 = grafted(current, rig, 6)
    const out = migrateProjectData(v6)
    const sketch = out.geometry[0].sketches![0]
    const plan = planDimension(sketch.entities as any, [rig.chamferLineId], sketch.constraints as any)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.plan.kind).toBe('d1xd2') // NOT 'distance' (the hypotenuse regression)
      expect((plan.plan as { value: number; d2: number }).value).toBeCloseTo(3, 6)
      expect((plan.plan as { value: number; d2: number }).d2).toBeCloseTo(3, 6)
    }
  })

  it('(b) an ORDINARY line (no rig at all) is untouched -- stays unmarked, plain distance', () => {
    const current = migrateProjectData(makeLegacyProject())
    const ordinary = {
      id: 'ordinary-sketch', layerId: 'layer-1',
      entities: [{ id: 'freehand', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 5, y: 5 } }],
      constraints: [], dimensions: [], solveStatus: null,
    }
    const out = migrateProjectData(grafted(current, ordinary, 6))
    const line = out.geometry[0].sketches?.[0].entities[0] as any
    expect(line.chamferSetback).toBeUndefined()
  })

  it('(c) unmarked INCOMPLETE rig (hostB joint entirely missing, zero pins) -> NOT backfilled, stays an ordinary line', () => {
    const current = migrateProjectData(makeLegacyProject())
    const out = migrateProjectData(grafted(current, incompleteRigSketch(), 6))
    const line = out.geometry[0].sketches?.[0].entities.find((e: any) => e.id === 'chamfer') as any
    expect(line.chamferSetback).toBeUndefined()
  })

  it('(d) MARKED line whose rig cannot resolve -> untouched by backfill; the EXISTING named refusal still fires at dim time', () => {
    const current = migrateProjectData(makeLegacyProject())
    const broken = {
      id: 'broken-marked-sketch', layerId: 'layer-1',
      entities: [
        { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'chamfer', kind: 'line', construction: false, start: { x: 7, y: 0 }, end: { x: 8, y: 5 },
          chamferSetback: true },
      ],
      constraints: [
        { id: 'j1', kind: 'coincident', a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'end' } },
      ],
      dimensions: [], solveStatus: null,
    }
    const out = migrateProjectData(grafted(current, broken, 6))
    const sketch = out.geometry[0].sketches![0]
    const line = sketch.entities.find((e: any) => e.id === 'chamfer') as any
    expect(line.chamferSetback).toBe(true) // untouched (still marked, backfill has nothing to add)
    const plan = planDimension(sketch.entities as any, ['chamfer'], sketch.constraints as any)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('theoretical corner unresolved')
  })

  it('(e) an ALREADY-marked line with a resolvable rig, migrated/loaded AGAIN -> idempotent: no duplicate warning, no reprocessing', () => {
    const current = migrateProjectData(makeLegacyProject())
    const rig = preR1ChamferSketch(3)
    const onceBackfilled = migrateProjectData(grafted(current, rig, 6))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const twice = migrateProjectData(onceBackfilled)
      const line = twice.geometry[0].sketches?.[0].entities.find((e: any) => e.id === rig.chamferLineId) as any
      expect(line.chamferSetback).toBe(true)
      const backfillWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('backfilling chamferSetback'))
      expect(backfillWarnings).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('(f) a FORGED chamferSetback:true on a line with NO rig at all -> not "repaired" by backfill; dim-time named refusal, unchanged', () => {
    const current = migrateProjectData(makeLegacyProject())
    const forged = {
      id: 'forged-marker-sketch', layerId: 'layer-1',
      entities: [{ id: 'freehand', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 5, y: 5 }, chamferSetback: true }],
      constraints: [], dimensions: [], solveStatus: null,
    }
    const out = migrateProjectData(grafted(current, forged, 6))
    const sketch = out.geometry[0].sketches![0]
    const line = sketch.entities[0] as any
    expect(line.chamferSetback).toBe(true) // untouched
    const plan = planDimension(sketch.entities as any, ['freehand'], sketch.constraints as any)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('theoretical corner unresolved')
  })

  it('(g) malformed rig FIELDS -- each NOT backfilled, asserted individually', () => {
    const current = migrateProjectData(makeLegacyProject())

    // (g1) truthy-non-true chamferSetback on the candidate line itself, otherwise a VALID rig --
    // never "repaired" to true (the field already has an opinion, however malformed).
    const rig = preR1ChamferSketch(3)
    const malformedMarker = {
      ...rig,
      entities: rig.entities.map((e: any) => (e.id === rig.chamferLineId ? { ...e, chamferSetback: 'yes' } : e)),
    }
    const outMalformedMarker = migrateProjectData(grafted(current, malformedMarker, 6))
    const g1Line = outMalformedMarker.geometry[0].sketches?.[0].entities
      .find((e: any) => e.id === rig.chamferLineId) as any
    expect(g1Line.chamferSetback).toBe('yes') // untouched, NOT overwritten to true

    // (g2) non-construction phantom -- resolveChamferCorner refuses (its own construction-only
    // filter, UI-50C-R1 major 2), so this is unmarked-and-untouched exactly like case (c).
    const nonConstructionPhantom = {
      id: 'g2-sketch', layerId: 'layer-1',
      entities: [
        { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
        { id: 'chamfer', kind: 'line', construction: false, start: { x: 7, y: 0 }, end: { x: 10, y: 3 } },
        { id: 'phantom', kind: 'point', construction: false, at: { x: 10, y: 0 } }, // NOT construction
      ],
      constraints: [
        { id: 'j1', kind: 'coincident', a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'end' } },
        { id: 'j2', kind: 'coincident', a: { entityId: 'chamfer', site: 'end' }, b: { entityId: 'B', site: 'start' } },
        { id: 'p1', kind: 'point_on_object', point: { entityId: 'phantom', site: 'self' }, object: 'A' },
        { id: 'p2', kind: 'point_on_object', point: { entityId: 'phantom', site: 'self' }, object: 'B' },
      ],
      dimensions: [], solveStatus: null,
    }
    const outG2 = migrateProjectData(grafted(current, nonConstructionPhantom, 6))
    const g2Line = outG2.geometry[0].sketches?.[0].entities.find((e: any) => e.id === 'chamfer') as any
    expect(g2Line.chamferSetback).toBeUndefined()

    // (g3) same host twice -- resolveChamferCorner refuses (UI-50C-R1 major 2's distinct-hosts check).
    const sameHostTwice = {
      id: 'g3-sketch', layerId: 'layer-1',
      entities: [
        { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'chamfer', kind: 'line', construction: false, start: { x: 2, y: 0 }, end: { x: 8, y: 0 } },
      ],
      constraints: [
        { id: 'j1', kind: 'coincident', a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'start' } },
        { id: 'j2', kind: 'coincident', a: { entityId: 'chamfer', site: 'end' }, b: { entityId: 'A', site: 'end' } },
      ],
      dimensions: [], solveStatus: null,
    }
    const outG3 = migrateProjectData(grafted(current, sameHostTwice, 6))
    const g3Line = outG3.geometry[0].sketches?.[0].entities.find((e: any) => e.id === 'chamfer') as any
    expect(g3Line.chamferSetback).toBeUndefined()

    // (g4) parallel hosts -- resolveChamferCorner refuses ('parallel-legs').
    const parallelHosts = {
      id: 'g4-sketch', layerId: 'layer-1',
      entities: [
        { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'B', kind: 'line', construction: false, start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
        { id: 'chamfer', kind: 'line', construction: false, start: { x: 3, y: 0 }, end: { x: 3, y: 5 } },
        { id: 'phantom', kind: 'point', construction: true, at: { x: 3, y: 2.5 } },
      ],
      constraints: [
        { id: 'j1', kind: 'coincident', a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'start' } },
        { id: 'j2', kind: 'coincident', a: { entityId: 'chamfer', site: 'end' }, b: { entityId: 'B', site: 'start' } },
        { id: 'p1', kind: 'point_on_object', point: { entityId: 'phantom', site: 'self' }, object: 'A' },
        { id: 'p2', kind: 'point_on_object', point: { entityId: 'phantom', site: 'self' }, object: 'B' },
      ],
      dimensions: [], solveStatus: null,
    }
    const outG4 = migrateProjectData(grafted(current, parallelHosts, 6))
    const g4Line = outG4.geometry[0].sketches?.[0].entities.find((e: any) => e.id === 'chamfer') as any
    expect(g4Line.chamferSetback).toBeUndefined()

    // (g5) WO UI-50C-R3 MAJOR 3: the ACTUAL "single pin" rig -- both distinct nonparallel hosts,
    // both chamfer endpoint joints, a genuine construction phantom, but exactly ONE point_on_object
    // pin (to hostA only). resolveChamferCorner's phantom search intersects "pinned to hostA" with
    // "pinned to hostB" -- a single pin makes that intersection empty, so it refuses
    // 'no-theoretical-corner' the same as no phantom at all. NOT backfilled, no warning, byte-stable,
    // ordinary-line (plain distance) behavior -- never the named dim-time refusal (case (d)), because
    // the line is never MARKED in the first place.
    const singlePin = singlePinRigSketch()
    const singlePinWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let outG5: ReturnType<typeof migrateProjectData>
    try {
      outG5 = migrateProjectData(grafted(current, singlePin, 6))
      expect(singlePinWarn).not.toHaveBeenCalled()
    } finally {
      singlePinWarn.mockRestore()
    }
    const g5Sketch = outG5.geometry[0].sketches![0]
    const g5Line = g5Sketch.entities.find((e: any) => e.id === 'chamfer') as any
    expect(g5Line.chamferSetback).toBeUndefined()
    // Byte stability: a second migration pass over the already-migrated document changes nothing.
    const outG5Again = migrateProjectData(outG5)
    expect(JSON.stringify(outG5Again)).toBe(JSON.stringify(outG5))
    // Ordinary-line behavior: planDimension resolves the plain hypotenuse distance, not d1xd2, and
    // never the named theoretical-corner refusal (the line was never marked, so dim time never
    // attempts chamfer-corner resolution at all).
    const g5Plan = planDimension(g5Sketch.entities as any, ['chamfer'], g5Sketch.constraints as any)
    expect(g5Plan.ok).toBe(true)
    if (g5Plan.ok) expect(g5Plan.plan.kind).not.toBe('d1xd2')
  })

  it('(h) ARCHITECT RULING -- a pre-R1 HAND-BUILT structure byte-identical to the SKC-41A rig IS backfilled (structure is identity at the pre-R1 boundary)', () => {
    // Built WITHOUT chamferTool -- a user coincidence-joined a line to two others and pinned a
    // construction point to both, entirely by hand. Mechanically indistinguishable from a genuine
    // tool-built rig at the pre-R1 boundary (no provenance exists) -- the ruling says this IS
    // backfilled, with the consequence (a coincidental d1xd2 default) named plainly in the code.
    const current = migrateProjectData(makeLegacyProject())
    const handBuilt = {
      id: 'hand-built-sketch', layerId: 'layer-1',
      entities: [
        { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
        { id: 'coincidence', kind: 'line', construction: false, start: { x: 7, y: 0 }, end: { x: 10, y: 3 } },
        { id: 'phantom', kind: 'point', construction: true, at: { x: 10, y: 0 } },
      ],
      constraints: [
        { id: 'j1', kind: 'coincident', a: { entityId: 'coincidence', site: 'start' }, b: { entityId: 'A', site: 'end' } },
        { id: 'j2', kind: 'coincident', a: { entityId: 'coincidence', site: 'end' }, b: { entityId: 'B', site: 'start' } },
        { id: 'p1', kind: 'point_on_object', point: { entityId: 'phantom', site: 'self' }, object: 'A' },
        { id: 'p2', kind: 'point_on_object', point: { entityId: 'phantom', site: 'self' }, object: 'B' },
      ],
      dimensions: [], solveStatus: null,
    }
    const out = migrateProjectData(grafted(current, handBuilt, 6))
    const line = out.geometry[0].sketches?.[0].entities.find((e: any) => e.id === 'coincidence') as any
    expect(line.chamferSetback).toBe(true)
  })

  it('(i) backfill runs at the UNCONDITIONAL load boundary, not gated to the v7->v8 step -- a document ALREADY at v8 with an unmarked legacy rig still heals', () => {
    const current = migrateProjectData(makeLegacyProject())
    const rig = preR1ChamferSketch(3)
    // schemaVersion CURRENT (v8): the v7->v8 migration step never runs at all for this document.
    const alreadyV8 = grafted(current, rig, CURRENT_PROJECT_SCHEMA_VERSION)
    const out = migrateProjectData(alreadyV8)
    const line = out.geometry[0].sketches?.[0].entities.find((e: any) => e.id === rig.chamferLineId) as any
    expect(line.chamferSetback).toBe(true)
  })

  it('backfillChamferSetbackMarkers is pure and byte-stable on a document with no lines at all', () => {
    const current = migrateProjectData(makeLegacyProject())
    expect(backfillChamferSetbackMarkers(current)).toBe(current)
  })

  it('backfillChamferSetbackMarkers in isolation: byte-stable when nothing qualifies', () => {
    const p = {
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      geometry: [{ id: 'g1', sketches: [incompleteRigSketch()] }],
    }
    expect(backfillChamferSetbackMarkers(p)).toBe(p)
  })

  it('fixture sanity: buildPreR1ChamferRig produces a rig with NO chamferSetback marker (the pre-R1 shape)', () => {
    const rig = buildPreR1ChamferRig(3)
    const line = rig.entities.find((e) => e.id === rig.chamferLineId) as any
    expect(line.chamferSetback).toBeUndefined()
  })
})

// ---- NEST-MODAL-SPACING-VET: normalizeNestRecords (load-boundary backfill) ---
// A nest record's `spacing`/`sheet` are REQUIRED at the TypeScript type but
// nothing enforces that at the JSON load boundary -- a hand-edited/legacy
// .camproject, or a nest record from a path other than the New Nest modal, can
// carry an absent or partial spacing/sheet. NestModal's EDIT-open path fed such
// a field straight into a NumericInput's `value` prop, which crashes on mount
// (see NestModal.tsx's own comment at the mergeNestSettings call site). This
// normalizes at the SAME unconditional load boundary the chamfer/model-item
// backfills above already use, so every consumer (the modal AND
// recomputeNest's worker payload) sees complete records.

describe('NEST-MODAL-SPACING-VET: normalizeNestRecords backfills incomplete nest spacing/sheet at load', () => {
  function baseNest(overrides: Record<string, unknown>) {
    return {
      id: 'nest-1', name: 'Nest 1',
      sheet: { width: 300, height: 200 },
      style: 'ninety', seed: 1,
      spacing: { partGap: 3, sheetMargin: 5, windowGap: 2 },
      sources: [], placements: [], unplaced: [], utilization: 0, visible: true,
      ...overrides,
    }
  }

  it('a nest with spacing MISSING ENTIRELY (pre-P1.0-shape / hand-edited file) is backfilled to the engine defaults', () => {
    const p: any = { ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, nests: [baseNest({ spacing: undefined })] }
    const out: any = migrateProjectData(p)
    expect(out.nests[0].spacing).toEqual({ partGap: 3, sheetMargin: 5, windowGap: 2 })
  })

  it('a nest with spacing PARTIAL (windowGap missing -- the exact PP-UTILITY-S2 capture-fixture shape) is backfilled field-by-field, preserving the fields that ARE present', () => {
    const p: any = {
      ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      nests: [baseNest({ spacing: { partGap: 7, sheetMargin: 11 } })],
    }
    const out: any = migrateProjectData(p)
    expect(out.nests[0].spacing).toEqual({ partGap: 7, sheetMargin: 11, windowGap: 2 })
  })

  it('a nest with sheet MISSING is backfilled to the engine default sheet size', () => {
    const p: any = { ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, nests: [baseNest({ sheet: undefined })] }
    const out: any = migrateProjectData(p)
    expect(out.nests[0].sheet).toEqual({ width: 300, height: 300 })
  })

  it('a nest with NaN/non-numeric spacing fields (a corrupted value, not just absent) is backfilled the same as absent', () => {
    const p: any = {
      ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      nests: [baseNest({ spacing: { partGap: NaN, sheetMargin: 'x', windowGap: 4 } })],
    }
    const out: any = migrateProjectData(p)
    expect(out.nests[0].spacing).toEqual({ partGap: 3, sheetMargin: 5, windowGap: 4 })
  })

  it('a nest with COMPLETE finite spacing/sheet is returned byte-stable (no spurious rewrite)', () => {
    const complete = baseNest({})
    const p: any = { ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, nests: [complete] }
    const out: any = migrateProjectData(p)
    expect(out.nests[0]).toEqual(complete)
  })

  it('a project with no nests[] at all is untouched', () => {
    const p: any = { ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION }
    const out: any = migrateProjectData(p)
    expect(out.nests).toBeUndefined()
  })

  it('is IDEMPOTENT: a second migration pass over the already-backfilled output is byte-stable', () => {
    const p: any = { ...makeLegacyProject(), schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, nests: [baseNest({ spacing: undefined })] }
    const once: any = migrateProjectData(p)
    const twice: any = migrateProjectData(once)
    expect(twice.nests).toEqual(once.nests)
  })
})
