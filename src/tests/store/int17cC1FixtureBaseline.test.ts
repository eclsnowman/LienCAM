// WO INT-17C Stage C1, step 1 (preflight-mandated fixture-gap closure) --
// UPDATED in step 7 (the v12 migration lands here, see the second describe
// block below).
//
// coordination/work-orders/INT-17C-C1-PREFLIGHT.md section 3 ("Fixture gap"):
// no fixture anywhere in the repo -- on disk or synthetic-in-test -- combines a
// populated `Project.document` with `format:'model'` CAM geometry rows. That is
// exactly the scenario the v12 migration's hash-equality acceptance test
// (Stage C1 acceptance test #2) needs. The preflight's own extraction-order step
// 1 (section 2): "Add the missing test-wired fixture(s) ... and a baseline
// migration test asserting current (v11) behavior is captured byte-for-byte ...
// establishing the diff target for step 6 [now step 7]." This file is that
// fixture + that baseline test. Step 1 added no production code and no
// ModelItem/registry/seam work; step 7 is the step the preflight always meant
// this fixture to prove, and updates the SECOND describe block below in place
// (the fixture FILE on disk is never regenerated -- it stays the genuine "before"
// v11 snapshot; only the test's assertions on the LOADED, now-migrated result
// change, exactly as the original step-1 comment anticipated).
//
// REAL, not hand-authored: the fixture is produced by driving the REAL store
// actions -- registerLiveDocument + a real FeatureDag (the same seam
// int14ProjectDocument.test.ts drives), useCamStore.syncModelBodies (the real
// INT-17A adapter action int17aModelBodySync.test.ts drives) and
// saveProjectToFile (the real save path, captured via the same
// URL.createObjectURL stub both of those files use) -- never a hand-built JSON
// or base64 archive literal.
//
// Regeneration: run with INT17C_WRITE_FIXTURE=1 to rewrite the committed file
// (same write-key idiom as UI80_WRITE_FIXTURE in
// src/tests/doc/persist/pushPullMigration.test.ts). The default run READS the
// committed fixture and asserts against it, so a fixture that drifts from the
// real save path -- or a future step that regresses a preserved field -- fails
// here, named per property, not as an opaque deep-equal diff.
//
// stockId/stockIdLocked are asserted ABSENT by design, not populated: census
// finding in the preflight (section 1e) confirms setGeometryStock
// (store/index.ts:5411) refuses format:'model' rows via
// refuseStockAssignmentForModelBody -- there is NO real product path that puts a
// stock binding on a model row today. Forcing one via direct state mutation
// would be exactly the "improvised synthetic fixture" the mission forbids. A
// lossless migration must preserve "no binding" just as faithfully as a real
// one, so that absence is pinned explicitly below rather than skipped.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Project, ModelBodyDisplay } from '../../types'
import type { DerivedModelBody, LiveModelBody } from '../../lib/cam/modelBodyAdapter'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { CURRENT_PROJECT_SCHEMA_VERSION, MIGRATION_LEGACY_MODEL_ITEM_NAME } =
  await import('../../store/migrations/projectMigrations')
const { FeatureDag } = await import('../../doc/dag')
const { registerLiveDocument, resetDocumentHolder, takePendingDocumentSeed, LEGACY_MODEL_ITEM_ID } =
  await import('../../doc/documentHolder')

const FIXTURE_PATH = resolve(process.cwd(), 'test_fixtures/evidence/INT-17C/model-plus-cam-v11-baseline.camproject')
const FIXTURE_FOLDER_NAME = 'Model Bodies'

// -- fixtures -----------------------------------------------------------------

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p-int17c', name: 'INT-17C C1 Baseline Fixture', version: '1.0.0',
    createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000, maxSpindleRpm: 24000,
      minSpindleRpm: 8000, spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry: [], setups: [], activeSetupId: null, activeOperationId: null,
    sceneStock: { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [] },
    notes: '',
    ...over,
  } as Project
}

/** A genuinely modeled part: a sketch, an extrude built from it, and a fillet on
 *  the extrude -- real feature kinds/opTypes (not a placeholder single node),
 *  built with the same FeatureDag API every DAG test in the repo uses. */
function buildRealFeatureDag(): InstanceType<typeof FeatureDag> {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Base Sketch' } })
  dag.insertNode({
    id: 'F1',
    kind: 'feature',
    consumes: ['SK1'],
    // WO-214 (migrationV4ToV5, schema v5): extrude end conditions are explicit
    // persisted intent now. This helper doubles as the step-1 v11 SEED builder
    // (buildFixtureProject, INT17C_WRITE_FIXTURE=1 only -- the committed fixture
    // itself stays a frozen pre-v5 snapshot with no endCondition field) and, at
    // line ~345, as the step-7 "freshly authored under CURRENT" comparison
    // target for the migrated fixture. direction:'up' is non-midplane, so a
    // fresh v5 authoring of this same extrude persists endCondition:'blind'
    // explicitly -- the exact default migrationV4ToV5 backfills for a
    // historical extrude with this same direction and no endCondition.
    // WO-3317: WO-3234 (migrationV6ToV7) records an explicit wallMode on every
    // persisted extrude -- 'solid' for every schema-6 payload, since no schema-6
    // reader honoured a wall field. The migrated fixture carries it, so a freshly
    // authored extrude does too; nothing else about the payload moved.
    payload: { opType: 'extrude', sketchId: 'SK1', distance: 12, direction: 'up', boolMode: 'newBody', name: 'Bracket Body', endCondition: 'blind', wallMode: 'solid' },
  })
  dag.insertNode({
    id: 'F2',
    kind: 'feature',
    consumes: ['F1'],
    payload: { opType: 'fillet', ownerId: 'F1', edges: ['F1:BOX:edgeTop'], radius: 2, propagateTangent: true, name: 'Edge Fillet' },
  })
  return dag
}

function display(tag: number): ModelBodyDisplay {
  return {
    positions: [tag, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
  }
}
const derivedBody = (bodyId: string, version: number, tag: number): DerivedModelBody =>
  ({ bodyId, version, stableIds: [`${bodyId}:F0`, `${bodyId}:E0`], display: display(tag) })
const liveBody = (bodyId: string, name: string): LiveModelBody => ({ bodyId, name })

// -- the real save path ---------------------------------------------------------

let savedBlobs: Blob[] = []
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:int17c' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.setState({ project: makeProject() })
})

/** Builds the fixture project state through REAL store actions only: a live
 *  modeling document (registerLiveDocument, same seam as int14's test), two
 *  model bodies synced into CAM geometry rows (syncModelBodies, the real
 *  INT-17A adapter action), then color/hidden/folder set on ONE of the two rows
 *  through their real, ungated store actions (updateGeometryColor,
 *  patchGeometry, setGeometryFolderId + addGeometryFolder) -- the OTHER row is
 *  left at every field's real default, so the fixture pins both the populated
 *  and the absent case per property. */
function buildFixtureProject(): void {
  const dag = buildRealFeatureDag()
  registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))

  useCamStore.getState().syncModelBodies({
    live: [liveBody('b1', 'Bracket'), liveBody('b2', 'Bearing Block')],
    derived: [derivedBody('b1', 3, 0), derivedBody('b2', 1, 4)],
  })

  const entries = useCamStore.getState().project.geometry.filter((g) => g.format === 'model')
  const b1 = entries.find((g) => g.modelBody?.ref.bodyId === 'b1')!

  const folderId = useCamStore.getState().addGeometryFolder(FIXTURE_FOLDER_NAME)
  useCamStore.getState().updateGeometryColor(b1.id, '#ff8800')
  useCamStore.getState().patchGeometry(b1.id, { hidden: true })
  useCamStore.getState().setGeometryFolderId(b1.id, folderId)
  // b2 stays untouched -- default color/hidden/folderId, and (like b1) no
  // stock binding, since no real path can write one onto a model row today.
}

// ---------------------------------------------------------------------------------

describe('INT-17C Stage C1 step 1: real model+CAM fixture (regenerate with INT17C_WRITE_FIXTURE=1)', () => {
  it('the committed fixture exists and was produced by the real save path', async () => {
    if (process.env.INT17C_WRITE_FIXTURE === '1') {
      buildFixtureProject()
      const fileText = await saveAndCaptureFile()
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true })
      writeFileSync(FIXTURE_PATH, fileText, 'utf8')
    }
    expect(existsSync(FIXTURE_PATH)).toBe(true)

    // Structural sanity on whatever is currently committed (independent of the
    // detailed per-property baseline below): both axes this fixture exists to
    // combine are actually present.
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Project
    expect(typeof parsed.document).toBe('string')
    expect((parsed.document as string).length).toBeGreaterThan(0)
    const modelRows = parsed.geometry.filter((g) => g.format === 'model')
    expect(modelRows).toHaveLength(2)
  })
})

describe('INT-17C Stage C1 step 7: the v11 fixture migrates to CURRENT -- every step-1 CAM-side property still round-trips byte-identical, PLUS the new Model Item registry is populated', () => {
  it('loads the v11 fixture, migrates it to CURRENT, and preserves id/pose/color/visibility/folder/stock-binding + the modeling document, per property', async () => {
    expect(existsSync(FIXTURE_PATH)).toBe(true)
    const fileText = readFileSync(FIXTURE_PATH, 'utf8')

    useCamStore.setState({ project: makeProject() }) // fresh session, nothing inherited
    await useCamStore.getState().loadProjectFromFile(fileText)

    const loaded = useCamStore.getState().project
    // This IS the diff step 7 promised (preflight section 3, GO/NO-GO finding
    // 3): the fixture FILE on disk stays a genuine v11 file (the "before"
    // side, never regenerated by this test), but loading it through the
    // CURRENT app now runs it through the v12 migration
    // (migrateModelItemRegistry) -- so the LOADED result is v12-shaped, which
    // is exactly what this describe block now asserts.
    //
    // Schema advanced 12 -> 13 via commit b90fee5a2 (SKC-BLOCKS Stage 1, the
    // sketch 'block' entity kind claim step, migrateSketchBlockEntity) after
    // this fixture's baseline was first written. That step is a pure
    // IDENTITY transform for any project without a block-bearing sketch --
    // this fixture has none -- so it does not touch any property asserted
    // below; the literal pin just tracks CURRENT so this test keeps failing
    // loud (not silently passing) the next time the schema moves.
    expect(loaded.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    // 13 -> 14 (SKC-BLOCKS-S5 blockDefs) is identity for this def-less
    // fixture. 14 -> 15 adds the authored-document manifest that makes an
    // embedded model safe to hydrate after a browser reload. 15 -> 16 adds
    // setup default-height intent and each operation's height source. 16 -> 17
    // claims persisted Adaptive Clearing authored semantics. 17 -> 18 repairs
    // persisted open-contour entry intent; this fixture has no such operation.
    expect(loaded.schemaVersion).toBe(19)

    // -- the new Model Item registry (v12 migration steps 1-2) --
    expect(loaded.modelItems).toHaveLength(1)
    expect(loaded.modelItems![0].id).toBe(LEGACY_MODEL_ITEM_ID)
    expect(loaded.modelItems![0].name).toBe(MIGRATION_LEGACY_MODEL_ITEM_NAME)
    expect(loaded.modelItems![0].documentState).toBe('authored')
    expect(loaded.modelItems![0].documentStorageKey).toBeTypeOf('string')
    expect(loaded.modelItems![0].documentRevision).toBe(1)
    // Every pre-existing model row is tagged to the SAME legacy item, and a
    // body-filtered Placement exists for each -- identity, since nothing in
    // this fixture (or in the live product today) ever wrote a non-identity
    // pose onto a model row.
    expect(loaded.modelItemPlacements).toHaveLength(2)
    for (const bodyId of ['b1', 'b2']) {
      const placement = loaded.modelItemPlacements!.find((pl) => pl.bodyId === bodyId)
      expect(placement).toBeDefined()
      expect(placement!.modelItemId).toBe(LEGACY_MODEL_ITEM_ID)
      expect(placement!.position).toEqual({ x: 0, y: 0, z: 0 })
      expect(placement!.rotation).toEqual({ x: 0, y: 0, z: 0 })
    }

    const modelRows = loaded.geometry.filter((g) => g.format === 'model')
    expect(modelRows).toHaveLength(2)
    const b1 = modelRows.find((g) => g.modelBody?.ref.bodyId === 'b1')
    const b2 = modelRows.find((g) => g.modelBody?.ref.bodyId === 'b2')
    expect(b1).toBeDefined()
    expect(b2).toBeDefined()

    // -- b1: the POPULATED case, every preserved field named explicitly --
    expect(b1!.id).toBe('modelbody:b1')
    expect(b1!.name).toBe('Bracket')
    expect(b1!.filename).toBe('Bracket')
    expect(b1!.type).toBe('model')
    expect(b1!.format).toBe('model')
    expect(b1!.boundingBox).toEqual({
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 },
      size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 },
    })
    expect(b1!.faceCount).toBeUndefined()
    expect(b1!.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(b1!.rotation).toEqual({ x: 0, y: 0, z: 0 })
    expect(b1!.color).toBe('#ff8800')
    expect(b1!.loaded).toBe(true)
    expect(b1!.hidden).toBe(true)
    expect(typeof b1!.folderId).toBe('string')
    const folder = loaded.geometryFolders?.find((f) => f.id === b1!.folderId)
    expect(folder).toBeDefined()
    expect(folder!.name).toBe(FIXTURE_FOLDER_NAME)
    expect(b1!.stockId).toBeUndefined()
    expect(b1!.stockIdLocked).toBeUndefined()
    expect(b1!.ownerNestId).toBeUndefined()
    expect(b1!.modelBody?.ref.bodyId).toBe('b1')
    expect(b1!.modelBody?.ref.stableIds).toEqual(['b1:F0', 'b1:E0'])
    expect(b1!.modelBody?.ref.version).toBe(3)
    expect(b1!.modelBody?.display).toEqual(display(0))
    // v12 migration (step 7): backfilled to the legacy Model Item's id.
    expect(b1!.modelItemId).toBe(LEGACY_MODEL_ITEM_ID)
    // Cross-model audit (coordination/reports/INT-17C-C1-AUDIT.md, "BASELINE
    // TEST COVERAGE"): these 7 ImportedGeometry fields are 2D/import- or
    // STL-projection-only and inapplicable to a model-backed row -- pin them
    // absent so a future change that starts populating them on a model row
    // trips this net.
    expect(b1!.loops).toBeUndefined()
    expect(b1!.layers2d).toBeUndefined()
    expect(b1!.sketches).toBeUndefined()
    expect(b1!.projectionTolerance).toBeUndefined()
    expect(b1!.projectionStale).toBeUndefined()
    expect(b1!.loopsVersion).toBeUndefined()
    expect(b1!.projectionPlane).toBeUndefined()

    // -- b2: the ABSENT/default case, every field named explicitly too --
    expect(b2!.id).toBe('modelbody:b2')
    expect(b2!.name).toBe('Bearing Block')
    expect(b2!.filename).toBe('Bearing Block')
    expect(b2!.type).toBe('model')
    expect(b2!.format).toBe('model')
    expect(b2!.boundingBox).toEqual({
      min: { x: 4, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 },
      size: { x: -3, y: 1, z: 0 }, center: { x: 2.5, y: 0.5, z: 0 },
    })
    expect(b2!.faceCount).toBeUndefined()
    expect(b2!.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(b2!.rotation).toEqual({ x: 0, y: 0, z: 0 })
    expect(b2!.color).toBeUndefined()
    expect(b2!.loaded).toBe(true)
    expect(b2!.hidden).toBeUndefined()
    expect(b2!.folderId).toBeUndefined()
    expect(b2!.stockId).toBeUndefined()
    expect(b2!.stockIdLocked).toBeUndefined()
    expect(b2!.ownerNestId).toBeUndefined()
    expect(b2!.modelBody?.ref.bodyId).toBe('b2')
    expect(b2!.modelBody?.ref.stableIds).toEqual(['b2:F0', 'b2:E0'])
    expect(b2!.modelBody?.ref.version).toBe(1)
    expect(b2!.modelBody?.display).toEqual(display(4))
    // v12 migration (step 7): backfilled to the legacy Model Item's id.
    expect(b2!.modelItemId).toBe(LEGACY_MODEL_ITEM_ID)
    // Same audit nit as b1 above, pinned on the ABSENT-case row too.
    expect(b2!.loops).toBeUndefined()
    expect(b2!.layers2d).toBeUndefined()
    expect(b2!.sketches).toBeUndefined()
    expect(b2!.projectionTolerance).toBeUndefined()
    expect(b2!.projectionStale).toBeUndefined()
    expect(b2!.loopsVersion).toBeUndefined()
    expect(b2!.projectionPlane).toBeUndefined()

    // -- Project.document: the real modeled part round-trips byte-identical --
    const seed = takePendingDocumentSeed()
    expect(seed).not.toBeNull()
    const seedDag = seed!.dag
    expect(seedDag.has('SK1')).toBe(true)
    expect(seedDag.has('F1')).toBe(true)
    expect(seedDag.has('F2')).toBe(true)
    // Direct string equality against a freshly-built (deterministic, no
    // randomness in FeatureDag.insertNode) copy of the same authored graph --
    // the same "canonical serialize -> .toBe()" discipline
    // int14ProjectDocument.test.ts uses, catching an archive-canonicalization
    // mismatch that a parse-then-compare would hide.
    expect(seedDag.serialize()).toBe(buildRealFeatureDag().serialize())
  })
})
