// WO-1412: warm reopen + Regen All could not rebuild an imported body.
//
// makeHeadlessExecutor (modelBodyHoleRecognition.ts) is the dispatcher a warm
// reopen's Regen All drives to replay a document's full feature history
// through a transient kernel WITHOUT the operator ever visiting the Model
// tab. It had explicit cases for 'datum', 'sketch', and extrude 'feature'
// nodes only -- an 'import' node (a STEP-imported body) fell to the final
// branch and refused by name every time, even though the LIVE in-page
// executor's own 'import' branch (SolidsWorkbenchPage.tsx) already replays
// this exact node kind successfully.
//
// This suite drives recognizeModelBodyHoles -- the same headless seam
// SetupModal's bore/hole reselect uses on a cold document, and the function
// regenerateModelBodyHeadless (this WO's dispatcher) sits behind -- against a
// document whose ONLY body is an 'import' node, with no window/workbench
// hooks installed (vitest's default 'node' environment), so every call is
// forced through the headless path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))

const { createLocalGeomService } = await import('../../geom')
const { resetDocumentHolder, stashLoadedDocument } = await import('../../doc/documentHolder')
const { buildImportedStepModelArchive } = await import('../../doc/promoteImportedStepModel')
const {
  __setModelBodyHeadlessClientFactoryForTests,
  recognizeModelBodyHoles,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const { createFakeGeomClient } = await import('../model3d/fakeGeomClient')

// One blind hole, d=6, depth 8 (SolidsWorkbenchPage.resizeHoleImportedGeometry.
// wo1299.test.tsx's own fixture) -- proves recognition actually ran a real
// import replay rather than trivially returning an empty verdict list.
const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_single_hole_block.step')
const HOLE_CLASSES = ['throughHole', 'blindHole', 'counterboreStack']

function fixtureBytes(): ArrayBuffer {
  const source = readFileSync(STEP_FIXTURE)
  return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
}

/** A single-import-node document, cache key seeded with the real fixture's
 *  bytes -- the shape a warm reopen leaves behind: an 'import' node in the
 *  document's history, no live kernel, no window hooks. */
function seedImportedBodyDocument(cacheKey: string): Uint8Array {
  stepBytes.set(cacheKey, fixtureBytes())
  return buildImportedStepModelArchive({ fileName: 'fix_single_hole_block.step', cacheKey, name: 'Assembly' })
}

describe('WO-1412: headless replay can rebuild an imported body (warm reopen + Regen All)', () => {
  beforeEach(() => {
    resetDocumentHolder()
    stepBytes.clear()
  })

  afterEach(() => {
    __setModelBodyHeadlessClientFactoryForTests(null)
    resetDocumentHolder()
    stepBytes.clear()
  })

  it('acceptance 1: reselecting a hole on the imported body regenerates through the headless path -- no "does not support" refusal', async () => {
    expect(typeof window).toBe('undefined') // the exact "never visited the Model tab" precondition
    __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
    stashLoadedDocument(seedImportedBodyDocument('wo1412-cache-key'))

    const verdicts = await recognizeModelBodyHoles('IMP1')
    const holes = verdicts.filter((v) => HOLE_CLASSES.includes(v.featureClass))
    expect(holes.length, JSON.stringify(verdicts)).toBeGreaterThan(0)
  }, 30_000)

  it('acceptance 2: STEP bytes genuinely missing from the cache refuse by name, never with the misleading Save-Setup wording', async () => {
    __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
    // No stepBytes.set() for this cache key -- loadCachedStep resolves null.
    stashLoadedDocument(
      buildImportedStepModelArchive({ fileName: 'fix_single_hole_block.step', cacheKey: 'nowhere', name: 'Assembly' }),
    )

    await expect(recognizeModelBodyHoles('IMP1')).rejects.toThrow(/missing from IndexedDB/i)
    await expect(recognizeModelBodyHoles('IMP1')).rejects.not.toThrow(/Save Setup/i)
    await expect(recognizeModelBodyHoles('IMP1')).rejects.not.toThrow(/does not support/i)
  })

  it('acceptance 3: an import that yields zero solid bodies hits the "contains no solid bodies" refusal, reached headlessly', async () => {
    __setModelBodyHeadlessClientFactoryForTests(() => createFakeGeomClient({ importedBodies: [] }))
    stashLoadedDocument(seedImportedBodyDocument('wo1412-zero-body-key'))

    await expect(recognizeModelBodyHoles('IMP1')).rejects.toThrow(/contains no solid bodies/i)
    await expect(recognizeModelBodyHoles('IMP1')).rejects.not.toThrow(/Save Setup/i)
  })
})
