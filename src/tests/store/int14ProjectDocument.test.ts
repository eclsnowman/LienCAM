// WO INT-14: the modeling document rides INSIDE the .camproject.
//
// Operator, the verdict this WO was cut from: "part workbench still has no save or
// load system. Stop telling me to do something I cannot do."
//
// These tests drive the REAL store actions -- useCamStore's saveProjectToFile and
// loadProjectFromFile -- because that wiring IS the deliverable. The DOC-3 archive
// itself has been round-tripping in src/tests/doc/persist/* for weeks; it was never
// plugged into the product. A format.ts-only round trip would pass on the broken
// build this WO exists to fix, so it proves nothing here (the WO says so in as many
// words). The save is captured by stubbing URL.createObjectURL, which is what
// saveProjectToFile hands the Blob to -- so what these tests read back is the exact
// byte stream the browser would have downloaded.
//
// Coverage map: AC1 (round trip), AC2 (one file), AC3 (2D-only no-perturbation +
// golden v9 fixture), AC4 (newer PROJECT schema), AC5 (newer DOCUMENT archive),
// AC6 (v8->v9 migration), and the amendment-6 fail-loud matrix cells (i)-(iv).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import type { Project } from '../../types'
import { typedMock } from '../support/typedMock'

// No real IndexedDB here; collectProjectBinaries reads through these. "Not found"
// is fine -- every project below is 2D-geometry-free, so needsBinary never fires.
// (Same shape/pattern projectBinaries.test.ts and alertScopeGuardUI11B.test.ts use.)
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
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')
const { FeatureDag } = await import('../../doc/dag')
const { createDocumentArchive, loadDocumentArchive, InMemoryDocumentStorage } = await import('../../doc/persist')
const {
  collectDocumentArchive,
  documentIdForProject,
  markDocumentDirty,
  registerLiveDocument,
  resetDocumentHolder,
  setDocumentStorage,
  startDocumentAutosave,
  takePendingDocumentSeed,
  hasLiveDocument,
} = await import('../../doc/documentHolder')
const { arrayBufferToBase64 } = await import('../../lib/projectBinaries')

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

// -- fixtures ---------------------------------------------------------------------

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'Saved Project', version: '1.0.0',
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      notes: '',
    },
    toolLibrary: [], geometry: [], setups: [],
    activeSetupId: null, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
    },
    notes: '',
    ...over,
  } as Project
}

function makeDag(featureId = 'F1', height = 5): InstanceType<typeof FeatureDag> {
  const dag = new FeatureDag()
  dag.insertNode({ id: featureId, kind: 'feature', payload: { opType: 'extrude', height } })
  return dag
}

function restampArchive(archive: Uint8Array, schemaVersion: number): Uint8Array {
  const files = unzipSync(archive)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  manifest.schemaVersion = schemaVersion
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  const zippable: Zippable = {}
  for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

// -- the real save path -----------------------------------------------------------

let savedBlobs: Blob[] = []
let alertSpy: ReturnType<typeof vi.fn>

/** Drive the REAL saveProjectToFile and return the exact JSON text the browser
 *  would have downloaded. */
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  alertSpy = vi.fn()
  vi.stubGlobal('alert', alertSpy)
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:int14' },
    revokeObjectURL: () => {},
  })
  // saveProjectToFile builds an <a> and clicks it; jsdom is absent in this env, so
  // the document/anchor are stubbed to no-ops. Nothing here is asserted on -- the
  // Blob captured above is the artifact.
  vi.stubGlobal('document', {
    createElement: () => ({ href: '', download: '', click: () => {} }),
  })
  useCamStore.setState({ project: makeProject() })
})

// ---------------------------------------------------------------------------------

describe('INT-14 AC1/AC2: save -> clear -> load round trip through the REAL store path', () => {
  it('restores the feature tree from the .camproject alone (one file, no sidecar)', async () => {
    // A live workbench document, exactly as the mounted page registers it.
    const dag = makeDag('F1', 5)
    registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))
    const before = dag.serialize()

    const fileText = await saveAndCaptureFile()

    // AC2: the model is IN the one saved file. Not a sidecar, not a cache.
    const parsed = JSON.parse(fileText) as Project
    expect(typeof parsed.document).toBe('string')
    expect((parsed.document as string).length).toBeGreaterThan(0)

    // Wipe EVERY trace of the in-memory document + holder state: this is the
    // "fresh browser / fresh cache" of AC2. All that survives is `fileText`.
    resetDocumentHolder()
    expect(collectDocumentArchive()).toBeUndefined()
    expect(hasLiveDocument()).toBe(false)

    // LOAD: the real store action, handed the file's text (what File > Open does).
    await useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()

    // AC1: the feature tree is back, byte-for-byte identical. Direct STRING
    // equality, NOT JSON-parse-then-compare: FeatureDag.serialize() is now
    // genuinely canonical (recursively sorts payload/diagnostics keys,
    // dag.ts), so its output survives the archive's own canonicalization
    // (format.ts:97) unchanged. A parse-then-compare would hide an
    // archive-canonicalization mismatch (INT-14-R1 audit item 4); .toBe()
    // catches it. The banked coordination/evidence/INT-14/R1/blocked/
    // item4-string-equality-RED.log is exactly this assertion failing before
    // the dag.ts fix -- it is GREEN now because serialize is canonical, not
    // because the comparison was weakened.
    const seed = takePendingDocumentSeed()
    expect(seed).not.toBeNull()
    expect((seed as NonNullable<typeof seed>).dag.serialize()).toBe(before)
    expect((seed as NonNullable<typeof seed>).dag.has('F1')).toBe(true)
  })

  // THE killer case (preflight amendment 1): the model must survive a user who
  // never opens the Model workspace at all. This is the interleave that a
  // component-handle seam would have silently failed.
  it('load -> save WITHOUT ever mounting the workbench keeps the model (no silent drop)', async () => {
    const dag = makeDag('F_KEEP', 42)
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const fileText = JSON.stringify(
      makeProject({ schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, document: arrayBufferToBase64(new Uint8Array(archive).buffer) }),
    )

    await useCamStore.getState().loadProjectFromFile(fileText)
    expect(alertSpy).not.toHaveBeenCalled()
    // The user never enters the Model workspace: NOTHING registers a live document.
    expect(hasLiveDocument()).toBe(false)

    const resaved = JSON.parse(await saveAndCaptureFile()) as Project
    expect(typeof resaved.document).toBe('string')
    const reloaded = loadDocumentArchive(new Uint8Array(Buffer.from(resaved.document as string, 'base64')))
    expect(reloaded.dag.has('F_KEEP')).toBe(true)
    expect((reloaded.dag.getNode('F_KEEP') as unknown as { payload: { height: number } }).payload.height).toBe(42)
  })
})

// WO INT-14-R1 (audit MAJOR: "autosave recovery is never invoked at a production
// startup/open point"). These drive the REAL loadProjectFromFile and nothing else
// -- no test-side bridge between reading a recovery and stashing it. That bridge
// is exactly what let the previous round's recovery test pass over a product that
// had no recovery path at all, so its absence here is the whole point: if the
// store stops calling recovery, these go red.
describe('INT-14-R1: autosave recovery at the production open point', () => {
  /** Autosave a document for `projectId`, the way a session that then CRASHED
   *  would have left it: written, and never clean-marked. Uses the real
   *  AutosaveController through the real holder -- the blob under test is the
   *  one production writes, not a hand-built lookalike. */
  async function leaveCrashedAutosave(projectId: string, dag: InstanceType<typeof FeatureDag>): Promise<void> {
    const storage = new InMemoryDocumentStorage()
    const unregister = registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))
    const controller = startDocumentAutosave({ documentId: documentIdForProject(projectId), storage, debounceMs: 0 })
    markDocumentDirty()
    await controller.flush()
    unregister()
    // The crash: everything in memory is gone. Only the storage survives, which
    // is why it is re-pointed after the reset rather than before it.
    resetDocumentHolder()
    setDocumentStorage(storage)
  }

  /** The file on disk carries an OLDER model than the autosave blob -- the
   *  situation recovery exists for: work done after the last manual save. */
  function fileWithModel(projectId: string, dag: InstanceType<typeof FeatureDag>): string {
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    return JSON.stringify(makeProject({
      id: projectId,
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      document: arrayBufferToBase64(new Uint8Array(archive).buffer),
    }))
  }

  it('offers the recovered model on open and, when accepted, seeds it through the ordinary load path', async () => {
    const fileText = fileWithModel('p-recover', makeDag('F_FILE', 1))
    await leaveCrashedAutosave('p-recover', makeDag('F_UNSAVED', 99))

    useCamStore.getState().loadProjectFromFile(fileText)
    // WO-1268 moved this prompt off the native bubble onto the app's themed
    // confirm, so the offer now arrives as a pending dialog in the store rather
    // than a window.confirm call. It is still async (it chains off the open's own
    // tail), so wait for it rather than asserting into a race.
    await vi.waitFor(() => expect(useCamStore.getState().confirmDialog).not.toBeNull())

    // The user was ASKED, by name -- never silently overridden.
    const offer = useCamStore.getState().confirmDialog!
    expect(`${offer.title} ${offer.body ?? ''}`).toMatch(/never saved|recovered/i)
    useCamStore.getState().resolveConfirm(true)

    // ...and the ACCEPTED recovery is what the workbench will now seed from:
    // F_UNSAVED (the autosaved work), not F_FILE (the older model in the file).
    await vi.waitFor(() => {
      const seed = takePendingDocumentSeed()
      expect(seed).not.toBeNull()
      expect((seed as NonNullable<typeof seed>).dag.has('F_UNSAVED')).toBe(true)
      expect((seed as NonNullable<typeof seed>).dag.has('F_FILE')).toBe(false)
    })
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('DECLINING the offer keeps the model the file was saved with', async () => {
    const fileText = fileWithModel('p-decline', makeDag('F_FILE', 1))
    await leaveCrashedAutosave('p-decline', makeDag('F_UNSAVED', 99))

    // WO-1268: themed confirm, declined below once it is pending.

    useCamStore.getState().loadProjectFromFile(fileText)
    await vi.waitFor(() => expect(useCamStore.getState().confirmDialog).not.toBeNull())
    useCamStore.getState().resolveConfirm(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Declining is not a no-op that leaves the door open: the file's own document
    // stays stashed, so the next mount seeds THAT, and the recovery is dropped.
    const seed = takePendingDocumentSeed()
    expect(seed).not.toBeNull()
    expect((seed as NonNullable<typeof seed>).dag.has('F_FILE')).toBe(true)
    expect((seed as NonNullable<typeof seed>).dag.has('F_UNSAVED')).toBe(false)
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('a clean previous session is never asked about (no "restore your work?" on an ordinary open)', async () => {
    const fileText = fileWithModel('p-clean', makeDag('F_FILE', 1))
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())

    useCamStore.getState().loadProjectFromFile(fileText)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // WO-1268: the offer is a themed dialog now; a clean session raises none.
    expect(useCamStore.getState().confirmDialog).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
  })
})

describe('INT-14 AC3: a 2D-only project is not perturbed', () => {
  it('omits the `document` key entirely and differs from a pre-INT-14 save ONLY in the schema stamp', async () => {
    // No workbench, no model -- the ordinary CAM user.
    const fileText = await saveAndCaptureFile()
    const parsed = JSON.parse(fileText) as Record<string, unknown>

    // (a) the key is ABSENT, not present-and-empty (which would perturb every
    //     2D-only file and hand the loader a string that is not an archive).
    expect('document' in parsed).toBe(false)
    expect(parsed.binaries).toBeUndefined()

    // (b) byte-equality against the golden current-schema 2D-only fixture
    //     below. Literal byte-identity to a *v8* file is impossible and
    //     deliberately NOT asserted: save stamps schemaVersion =
    //     CURRENT_PROJECT_SCHEMA_VERSION, so the stamp moves by construction
    //     as the schema advances (preflight amendment 4; was 8 -> 9, now
    //     tracks whatever CURRENT_PROJECT_SCHEMA_VERSION is).
    expect(parsed.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(fileText).toBe(GOLDEN_CURRENT_2D_ONLY)
  })

  it('merely visiting the Model workspace does not start writing a document into 2D-only projects', async () => {
    // A freshly-mounted workbench holds Origin + XY/XZ/YZ and nothing else. Its
    // collector returns null for that, so the field stays omitted.
    registerLiveDocument(() => null)
    const parsed = JSON.parse(await saveAndCaptureFile()) as Record<string, unknown>
    expect('document' in parsed).toBe(false)
    expect(parsed.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
  })
})

describe('INT-14 AC6: the v8 -> v9 project migration', () => {
  it('opens a pre-v9 file unchanged -- no document, no refusal, no materialized field', () => {
    const v8 = JSON.stringify(makeProject({ schemaVersion: 8 }))
    useCamStore.getState().loadProjectFromFile(v8)

    expect(alertSpy).not.toHaveBeenCalled()
    const loaded = useCamStore.getState().project
    expect(loaded.name).toBe('Saved Project')
    // The step is an IDENTITY: it claims the version, it does not materialize
    // `document` on a file that never had one.
    expect(loaded.document).toBeUndefined()
    expect(loaded.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(takePendingDocumentSeed()).toBeNull()
  })

  it('a project with no schemaVersion at all (v0) still migrates the whole chain to CURRENT', () => {
    const legacy = JSON.stringify(makeProject())
    useCamStore.getState().loadProjectFromFile(legacy)
    expect(alertSpy).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
  })

  // This literal is a deliberate pin (not a derived check): its whole job is
  // to force a conscious look at this AC6 matrix every time the schema
  // advances, so the number is intentionally hardcoded rather than compared
  // against itself. Bump it -- and re-read the matrix above -- on every
  // schema-version change.
  //
  // INT-17C Stage C1 step 7 (coordination/work-orders/INT-17C-C1-PREFLIGHT.md
  // section 3 / GO-NO-GO finding 3): bumped to 12 in that commit -- it lands
  // the v12 wrap-legacy-document-as-one-Model-Item migration
  // (migrateModelItemRegistry, src/store/migrations/projectMigrations.ts).
  // The v11 fixture + per-property baseline this literal stays in sync with
  // lives in src/tests/store/int17cC1FixtureBaseline.test.ts (Stage C1 step
  // 1); step 7's own hash-equality acceptance test
  // (int17cC1ModelItemMigration.test.ts) loads that same fixture and
  // migrates it, so this pin and that baseline move together.
  //
  // Bumped to 13 by commit b90fee5a2 (SKC-BLOCKS Stage 1): additive claim
  // step for the new sketch 'block' entity kind (migrateSketchBlockEntity,
  // src/store/migrations/projectMigrations.ts) -- an IDENTITY transform, so
  // it does not perturb this fixture's v12-era assertions. See
  // src/tests/store/blockMigration.test.ts for the v12->13 chain's own
  // additive/identity coverage.
  it('CURRENT_PROJECT_SCHEMA_VERSION is 18 -- the claim an older build fails loud against', () => {
    // 13 -> 14 (SKC-BLOCKS-S5): adds Sketch.blockDefs + SketchBlockEntity.defId,
    // additive/identity for any project without def-backed blocks (this fixture
    // has none). Chain coverage: src/tests/store/migrations.
    // 14 -> 15 adds the lightweight per-Model-Item document manifest; archive
    // bytes remain outside localStorage in the durable binary backend. 15 -> 16
    // adds setup default-height intent and each operation's height source.
    // 16 -> 17 claims persisted Adaptive Clearing authored semantics. 17 -> 18
    // repairs persisted open-contour entry intent to match pre-v18 plunge motion.
    expect(CURRENT_PROJECT_SCHEMA_VERSION).toBe(19)
  })
})

describe('INT-14 AC4/AC5: the fail-loud matrix (ADR-0003 -- name the cause, load NOTHING)', () => {
  // Cell (iii): newer PROJECT schema.
  it('refuses a NEWER project schema and loads nothing', () => {
    useCamStore.setState({ project: makeProject({ name: 'Still Mine' }) })
    const future = JSON.stringify(makeProject({ name: 'From The Future', schemaVersion: 999 }))

    useCamStore.getState().loadProjectFromFile(future)

    // The product deliberately moved this refusal off a blocking alert() onto
    // the non-blocking status-strip + console-event surface (UI-41 batch E) --
    // see alertScopeGuardUI11B.test.ts for the same convention.
    expect(alertSpy).not.toHaveBeenCalled()
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'project',
      message: expect.stringContaining('NEWER version of LienCAM'),
    })
    expect(useCamStore.getState().sketchNotice).toContain('NEWER version of LienCAM')
    expect(useCamStore.getState().project.name).toBe('Still Mine')
  })

  // Cell (i): newer DOCUMENT archive -> abort the WHOLE open, not "skip the model".
  it('refuses a NEWER document archive BY NAME and aborts the whole open', () => {
    useCamStore.setState({ project: makeProject({ name: 'Still Mine' }) })
    const future = restampArchive(createDocumentArchive({ dag: makeDag(), elementMapDeltas: [] }), 99)
    const fileText = JSON.stringify(
      makeProject({
        name: 'Model From The Future',
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        document: arrayBufferToBase64(new Uint8Array(future).buffer),
      }),
    )

    useCamStore.getState().loadProjectFromFile(fileText)

    expect(alertSpy).not.toHaveBeenCalled()
    const notice = useCamStore.getState().consoleEvents.at(-1)
    expect(notice).toMatchObject({ severity: 'error', source: 'project' })
    const message = String(notice?.message)
    // Named: the user is told it is the MODEL, and which version.
    expect(message).toContain('3D model')
    expect(message).toContain('NEWER version of LienCAM')
    expect(message).toContain('99')
    expect(useCamStore.getState().sketchNotice).toContain('3D model')
    // Loaded NOTHING: the whole open aborted. Opening the 2D half of a project
    // whose model silently vanished is exactly the partial ADR-0003 forbids.
    expect(useCamStore.getState().project.name).toBe('Still Mine')
    expect(takePendingDocumentSeed()).toBeNull()
    expect(collectDocumentArchive()).toBeUndefined()
  })

  // Cell (ii): corrupted archive bytes.
  it('refuses CORRUPTED document bytes by name and aborts the whole open', () => {
    useCamStore.setState({ project: makeProject({ name: 'Still Mine' }) })
    const fileText = JSON.stringify(
      makeProject({
        name: 'Damaged',
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        document: arrayBufferToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer),
      }),
    )

    useCamStore.getState().loadProjectFromFile(fileText)

    expect(alertSpy).not.toHaveBeenCalled()
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'project',
      message: expect.stringContaining('damaged or incomplete'),
    })
    expect(useCamStore.getState().sketchNotice).toContain('damaged or incomplete')
    expect(useCamStore.getState().project.name).toBe('Still Mine')
    expect(takePendingDocumentSeed()).toBeNull()
  })

  // Cell (iv): v9 WITHOUT a document loads unchanged.
  it('a v9 project with NO document loads normally and drops any previously-held model', () => {
    // A model-bearing project is open...
    const dag = makeDag('F_OLD')
    registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))

    useCamStore.getState().loadProjectFromFile(
      JSON.stringify(makeProject({ name: '2D Only', schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION })),
    )

    expect(alertSpy).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.name).toBe('2D Only')
    // The previous project's model must NOT survive into this one.
    expect(takePendingDocumentSeed()).toBeNull()
  })
})

describe('INT-14: the `document` field is never inherited from the project object', () => {
  // Caught by the both-mount test before this existed. saveProjectToFile spreads
  // `...project`, and a project parsed from a file carries `document` -- so the
  // stale bytes rode straight back out through the spread whenever the holder
  // said "no model". The holder must be the ONLY authority.
  it('a model-bearing project whose model is then emptied saves with NO document', async () => {
    const dag = makeDag('F_DOOMED')
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    useCamStore.getState().loadProjectFromFile(
      JSON.stringify(makeProject({
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        document: arrayBufferToBase64(new Uint8Array(archive).buffer),
      })),
    )
    // The user opens the Model workspace and deletes every feature: the live
    // document is now empty, so the collector reports null.
    registerLiveDocument(() => null)

    const parsed = JSON.parse(await saveAndCaptureFile()) as Record<string, unknown>
    expect('document' in parsed).toBe(false)
  })

  it('the loaded project in the store carries no base64 document copy', async () => {
    const archive = createDocumentArchive({ dag: makeDag(), elementMapDeltas: [] })
    await useCamStore.getState().loadProjectFromFile(
      JSON.stringify(makeProject({
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        document: arrayBufferToBase64(new Uint8Array(archive).buffer),
      })),
    )
    // The holder owns the model; the store holding a second (stale) copy would
    // both invite drift and push the whole model into localStorage on every edit.
    expect(useCamStore.getState().project.document).toBeUndefined()
    expect(collectDocumentArchive()).toBeDefined()
  })
})

describe('INT-14: New Project drops the modeling document', () => {
  it('a new project does not inherit (and then re-save) the previous model', async () => {
    const dag = makeDag('F_PREVIOUS')
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    await useCamStore.getState().loadProjectFromFile(
      JSON.stringify(makeProject({
        schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
        document: arrayBufferToBase64(new Uint8Array(archive).buffer),
      })),
    )
    expect(collectDocumentArchive()).toBeDefined()

    useCamStore.getState().newProject()

    const parsed = JSON.parse(await saveAndCaptureFile()) as Record<string, unknown>
    expect('document' in parsed).toBe(false)
  })
})

// ---------------------------------------------------------------------------------
// The golden current-schema 2D-only fixture (AC3(b), preflight amendment 4).
//
// This is the EXACT text saveProjectToFile produces for the `makeProject()` project
// with no modeling document. Its whole job is to be a tripwire: if a future edit
// starts perturbing 2D-only saves -- an empty `document: ""`, a reordered snapshot,
// a stray field -- this literal goes red and names the perturbation in the diff.
// Regenerating it to make it pass is only correct when the change to 2D-only files
// is itself intended. The `schemaVersion` field is the one deliberate exception:
// it is written from the live CURRENT_PROJECT_SCHEMA_VERSION constant (not a
// hardcoded number) because that stamp is DESIGNED to move with every schema
// bump (preflight amendment 4) -- pinning it as a literal would make this
// fixture fail on every unrelated version bump instead of only on real
// structural perturbations, which is not what this tripwire is for.
const GOLDEN_CURRENT_2D_ONLY = JSON.stringify(
  {
    id: 'p1',
    name: 'Saved Project',
    version: '1.0.0',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      notes: '',
    },
    toolLibrary: [],
    geometry: [],
    setups: [],
    activeSetupId: null,
    activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
    },
    notes: '',
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    toolLibraries: [{ id: 'lib-default', name: 'My Tools' }],
    holders: [],
  },
  null,
  2,
)
