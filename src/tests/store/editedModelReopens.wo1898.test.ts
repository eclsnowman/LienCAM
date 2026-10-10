// WO-1898: an edited model reopens with its edits (reproduction).
//
// `wrapImportedGeometryAsModelItem` (store/index.ts) copies an imported
// STEP/STL row's bytes under a FRESH IndexedDB cache key before building the
// Model Item's seed document (promoteImportedStepModel.ts /
// promoteImportedMeshModel.ts) -- the 'import'/'meshImport' node's
// `payload.cacheKey` is that fresh key, never the source CAM row's geometry
// id ("decouples the two independent cache lifetimes", promoteImportedStepModel.ts
// ImportedStepSeedInput.cacheKey doc comment). `collectProjectBinaries`
// (projectBinaries.ts:389-445) only embeds bytes for rows STILL carrying
// format 'stl'/'step' in `project.geometry`, keyed by the ROW's own id
// (`needsBinary`, projectBinaries.ts:58-62) -- once a row is adopted into a
// Model Item its format flips to 'model' (modelBodyAdapter.ts:264), so
// neither the ORIGINAL bytes nor the model's own fresh-cache-key COPY is ever
// embedded. A cold open (cleared IndexedDB / another browser) has nothing to
// replay the import node against (headlessModelBodyReplay.ts's
// `loadCachedStep(cacheKey)`): the model's bodies are gone even though the
// DAG/edit history inside the saved .camproject is completely intact.
//
// This suite proves the defect at the exact seam the WO's authority names --
// the real, unmodified `collectProjectBinaries` / `hydrateCachesFromBinaries`
// (projectBinaries.ts) and `buildImportedStepModelArchive`
// (promoteImportedStepModel.ts) -- with the IndexedDB STEP cache mocked to an
// in-memory map (the one seam with no Node equivalent, same pattern as
// wrapImportedStepAsModelItem.test.ts / headlessImportReplay.wo1412.test.ts).
//
// STATUS: reproduced only. The fix (embedding bytes for every Model Item
// document's import-node cache keys at save, so the existing generic
// `hydrateCachesFromBinaries` repopulates them at load -- proven possible by
// the second describe block below) needs `project.modelItems` and each
// item's document archive bytes, neither of which `collectProjectBinaries`'s
// current `(geometry)` signature receives. Wiring that in touches
// `src/store/index.ts` (`packageProjectToFile`'s binary collection), which is
// outside this WO's owned-paths and -- per WO-1819's own note in this queue,
// "FOUR orders own src/store/index.ts" -- is under live, unresolved
// contention from other worktrees right now. See "## Worker result" in this
// WO's own file for the full decision record.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry } from '../../types'

const stepBytesById = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytesById.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytesById.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytesById.delete(id) }),
  computeStepSha256: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async () => null),
  cacheStepDisplay: vi.fn(async () => {}),
  STEP_DISPLAY_CONTRACT_VERSION: 1,
  STEP_DISPLAY_AO_VERSION: 1,
}))

const { cacheStep, loadCachedStep } = await import('../../lib/stepCache')
const {
  collectProjectBinaries,
  embedModelItemImportBinaries,
  hydrateCachesFromBinaries,
  arrayBufferToBase64,
} = await import('../../lib/projectBinaries')
const { buildImportedStepModelArchive } = await import('../../doc/promoteImportedStepModel')
const { loadDocumentArchive } = await import('../../doc/persist')

const ORIGINAL_GEO_ID = 'geo-step-1898'
const MODEL_CACHE_KEY = 'model-item-fresh-cache-key-1898'
const ORIGINAL_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer

function importedStepRow(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: ORIGINAL_GEO_ID, name: 'Bracket', filename: 'bracket.step', type: 'brep', format: 'step',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 }, size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

/** Mirrors the store's own wrap-time copy (store/index.ts's local
 *  `cacheFreshStep` is a plain `cacheStep` call) + seed-archive build. */
async function wrapAsModelItem(originalBytes: ArrayBuffer): Promise<Uint8Array> {
  await cacheStep(MODEL_CACHE_KEY, originalBytes)
  return buildImportedStepModelArchive({
    fileName: 'bracket.step', cacheKey: MODEL_CACHE_KEY, name: 'Bracket',
  })
}

describe('WO-1898 reproduction: an edited model loses its bodies on a cleared cache', () => {
  beforeEach(() => {
    stepBytesById.clear()
    stepBytesById.set(ORIGINAL_GEO_ID, ORIGINAL_BYTES)
  })

  it('the seed document really does reference the fresh cache key (the document itself is not the defect)', async () => {
    const seedBytes = await wrapAsModelItem(ORIGINAL_BYTES)
    const { dag } = loadDocumentArchive(seedBytes)
    const node = dag.getNode('IMP1')
    expect(node?.kind).toBe('import')
    expect(node?.payload.cacheKey).toBe(MODEL_CACHE_KEY)
  })

  it('collectProjectBinaries embeds nothing for the adopted row, so the model cache key is never saved', async () => {
    await wrapAsModelItem(ORIGINAL_BYTES)

    // After adoption the CAM row's id survives but its format flips to
    // 'model' (modelBodyAdapter.ts syncModelBodies comment: "position + id
    // survive the flip to format:'model'"), so it is no longer a
    // needsBinary() candidate at all -- neither copy of the bytes is a save
    // target any more.
    const adoptedGeometry: ImportedGeometry[] = [importedStepRow({ format: 'model' })]

    const binaries = await collectProjectBinaries(adoptedGeometry)

    expect(binaries).toBeUndefined()
  })

  it('reproduces the reported symptom: a cleared cache cannot replay the edited model\'s import node', async () => {
    await wrapAsModelItem(ORIGINAL_BYTES)
    const adoptedGeometry: ImportedGeometry[] = [importedStepRow({ format: 'model' })]

    const binaries = await collectProjectBinaries(adoptedGeometry)

    // Simulate a cold open: cleared IndexedDB (a different browser, or the
    // cache evicted) -- only what `binaries` carries survives.
    stepBytesById.clear()
    await hydrateCachesFromBinaries(binaries ?? {})

    // The saved document still names MODEL_CACHE_KEY (proven above), but its
    // bytes are unrecoverable: the 'import' node's replay
    // (`loadCachedStep(cacheKey)`, headlessModelBodyReplay.ts /
    // SolidsWorkbenchPage.tsx) has nothing to import. The edited model
    // reopens with no bodies.
    expect(await loadCachedStep(MODEL_CACHE_KEY)).toBeNull()
  })

  it('FIX: embedding the model item import keys makes a cleared-cache open replay', async () => {
    const seedBytes = await wrapAsModelItem(ORIGINAL_BYTES)
    const adoptedGeometry: ImportedGeometry[] = [importedStepRow({ format: 'model' })]

    const binaries = await embedModelItemImportBinaries(
      [seedBytes], await collectProjectBinaries(adoptedGeometry),
    )
    expect(Object.keys(binaries ?? {})).toEqual([MODEL_CACHE_KEY])

    stepBytesById.clear()
    await hydrateCachesFromBinaries(binaries ?? {})
    const restored = await loadCachedStep(MODEL_CACHE_KEY)
    expect(new Uint8Array(restored!)).toEqual(new Uint8Array(ORIGINAL_BYTES))
  })

  it('a model with no import nodes leaves binaries untouched (undefined stays undefined)', async () => {
    expect(await embedModelItemImportBinaries([], undefined)).toBeUndefined()
  })
})

describe('WO-1898: hydrateCachesFromBinaries is already generic -- it needs only the right key embedded', () => {
  beforeEach(() => {
    stepBytesById.clear()
  })

  it('restores a model-item cache key exactly like a geometry-id key, once one is embedded under it', async () => {
    // Proves the load side needs NO change: `hydrateCachesFromBinaries`
    // repopulates whatever id each ProjectBinaries entry is keyed by, never
    // cross-checking it against `project.geometry`. The only gap is that
    // `collectProjectBinaries` (the SAVE side, scoped to `project.geometry`)
    // never produces an entry keyed by a Model Item's own cache key -- fixing
    // that requires `project.modelItems` and each item's document archive,
    // which live in src/store/index.ts's packageProjectToFile, not in
    // anything projectBinaries.ts currently receives.
    const binaries = {
      [MODEL_CACHE_KEY]: { step: arrayBufferToBase64(ORIGINAL_BYTES) },
    }

    await hydrateCachesFromBinaries(binaries)

    const restored = await loadCachedStep(MODEL_CACHE_KEY)
    expect(restored).not.toBeNull()
    expect(new Uint8Array(restored!)).toEqual(new Uint8Array(ORIGINAL_BYTES))
  })
})
