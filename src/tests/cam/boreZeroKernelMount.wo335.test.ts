// WO-335: picking a bore on Operator's OWN project (test_fixtures/evidence/WO-335/
// operator-bore-zero-repro.camproject) used to refuse with "open the Model tab
// once so the live kernel mounts, then pick the Bore wall again" whenever the
// Model tab had never been mounted -- an errand, not a fix. This suite drives
// the real, checked-in reproduction cold: the document is stashed exactly as
// project-open leaves it (documentHolder's pass-through path), no
// window.__solidsWorkbenchHooks is ever installed (this file runs in vitest's
// default 'node' environment, which has no `window` at all), and no test
// recognizer/snapshot-reader is injected -- so every call below is forced
// through modelBodyHoleRecognition.ts's new headless kernel-mount path.
//
// Against pre-WO-335 code this whole suite is RED: recognizeModelBodyHoles/
// readModelBodyFaceFacts throw the "open the Model tab" refusal immediately,
// before ever reaching a kernel. Verified by hand for this result (see the
// WO's "Worker result" section) by running this file against
// `git show main:src/lib/cam/modelBodyHoleRecognition.ts`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createLocalGeomService } from '../../geom'
import { resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import {
  __setModelBodyHeadlessClientFactoryForTests,
  readModelBodyFaceFacts,
  recognizeModelBodyHoles,
} from '../../lib/cam/modelBodyHoleRecognition'
import { resolveSetupBoreOriginPick } from '../../store'
import type { ImportedGeometry, ModelItemPlacementRecord } from '../../types'

const FIXTURE_PATH = path.resolve(
  __dirname, '../../../test_fixtures/evidence/WO-335/operator-bore-zero-repro.camproject',
)

interface FixtureProject {
  document: string
  geometry: ImportedGeometry[]
  modelItemPlacements: ModelItemPlacementRecord[]
}

function loadFixture(): FixtureProject {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as FixtureProject
}

/** The project's `document` field is the same base64-of-zip-bytes shape
 *  createDocumentArchive/collectDocumentArchive produce -- decode it back to
 *  the Uint8Array stashLoadedDocument (and, in production, loadProjectFromFile)
 *  consumes. */
function fixtureDocumentBytes(fixture: FixtureProject): Uint8Array {
  const buf = Buffer.from(fixture.document, 'base64')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

// The modeled body row his screenshot names: format 'model', tracking DAG
// node "F3" -- the live id after his base pad (F1), boss (F2), and bore (F3).
function boreGeometryRow(fixture: FixtureProject): ImportedGeometry {
  const geo = fixture.geometry.find((g) => g.modelBody?.ref.bodyId === 'F3')
  if (geo === undefined) throw new Error('fixture no longer carries a body row for DAG node "F3"')
  return geo
}

/**
 * Re-stamp the fixture document as though it had been authored inside a
 * NON-legacy Model Item's own workbench, rather than merely re-stashing the
 * SAME bytes under a different key.
 *
 * Every extrude's persisted end-target identity bakes in the modelItemId
 * that was "active" when the feature was created (SolidsWorkbenchPage.tsx's
 * own `modelItemId` local, threaded into buildExtrudeRequest) -- within any
 * ONE document that is always that document's own owning item, because a
 * workbench only ever mounts one item's document at a time. Node "F3" (the
 * bore, a boolean 'remove' extrude) persists exactly one such identity,
 * naming its target body "F2". Re-stashing the untouched bytes under a
 * different key would leave that persisted identity claiming "legacy" while
 * the caller asserts a different active item -- a real (and correct)
 * cross-item refusal at replay time, not the false-refusal bug this suite
 * targets. Patching it here is what actually makes "F3 belongs to a
 * non-legacy Model Item" true of the document's own contents.
 */
function nonLegacyFixtureBytes(fixture: FixtureProject, modelItemId: string): Uint8Array {
  const loaded = loadDocumentArchive(fixtureDocumentBytes(fixture))
  const node = loaded.dag.getNode('F3')
  if (node === undefined) throw new Error('fixture no longer carries DAG node "F3"')
  const payload = node.payload as { resolvedEndTargets?: Array<{ bodyFeatureId: string; modelItemId: string }> }
  const resolvedEndTargets = payload.resolvedEndTargets
  if (resolvedEndTargets === undefined || resolvedEndTargets.length === 0) {
    throw new Error('fixture node "F3" no longer persists a resolved end target to re-stamp')
  }
  loaded.dag.setPayload('F3', {
    ...node.payload,
    resolvedEndTargets: resolvedEndTargets.map((t) => ({ ...t, modelItemId })),
  })
  return createDocumentArchive({ dag: loaded.dag, elementMapDeltas: loaded.elementMapDeltas, parameters: loaded.parameters })
}

describe('WO-335: picking a bore cannot save because the kernel is not mounted', () => {
  beforeEach(() => {
    resetDocumentHolder()
    // Real occt-wasm kernel, in-process (no Worker/Comlink hop) -- the SAME
    // production path headlessModelBodyReplay.ts's own tests use for real
    // geometry evidence, injected only so this suite runs fast under vitest.
    __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  })

  afterEach(() => {
    __setModelBodyHeadlessClientFactoryForTests(null)
    resetDocumentHolder()
  })

  it('cold load, Model tab never opened: picking the bore wall computes the real origin', async () => {
    expect(typeof window).toBe('undefined') // the exact precondition his repro hit
    const fixture = loadFixture()
    stashLoadedDocument(fixtureDocumentBytes(fixture))

    const verdicts = await recognizeModelBodyHoles('F3')
    const bore = verdicts.find((v) => v.params.diameter === 15)
    expect(bore, JSON.stringify(verdicts)).toBeDefined()
    expect(bore!.faceIds).toHaveLength(1)
    const faceStableId = bore!.faceIds[0]

    const facts = await readModelBodyFaceFacts('F3', faceStableId)
    expect(facts.snapshot.type).toBe('cylinder')
    expect(facts.snapshot.radius).toBeCloseTo(7.5, 6)
    expect(facts.snapshot.centroid[0]).toBeCloseTo(-24.895063688586024, 6)
    expect(facts.snapshot.centroid[1]).toBeCloseTo(0, 6)

    // The exact call SetupModal's bore pick makes next (resolveBoreFaceOwner ->
    // readModelBodyFaceFacts -> resolveSetupBoreOriginPick) -- proving the
    // computed facts actually resolve to a usable setup origin, not just that
    // SOME promise settled.
    const geo = boreGeometryRow(fixture)
    const picked = resolveSetupBoreOriginPick(
      geo, 'F3', faceStableId, facts.snapshot, facts.verdicts, fixture.modelItemPlacements,
    )
    expect(picked.origin.x).toBeCloseTo(-24.8951, 3)
    expect(picked.origin.y).toBeCloseTo(0, 3)
    expect(picked.origin.z).toBeCloseTo(15, 3) // bore top rim: F3 cuts down 15 from z=15
    // SetupModal enables Save / sets the bore binding off exactly this shape
    // (SetupModal.tsx's handleStartBorePick: featureRef.kind === 'bore_center').
    const { originBinding } = picked
    if (originBinding.kind !== 'part_feature') {
      throw new Error(`expected a part_feature origin binding, got '${originBinding.kind}'`)
    }
    expect(originBinding.featureRef.kind).toBe('bore_center')
  }, 30_000)

  it('cold load, body owned by a NON-LEGACY Model Item ("New model" body): picking the bore wall computes the real origin', async () => {
    // Fix round (audit FAIL): the headless path used to hardcode
    // LEGACY_MODEL_ITEM_ID when asking documentHolder for the archive to
    // replay. Every body made with the design tree's own "New model" button
    // is stamped with its OWN (non-legacy) owning item id
    // (buildModelBodyGeometry, modelBodyAdapter.ts) and that item's document
    // is stashed under THAT id (replaceLoadedDocumentArchives), never under
    // "legacy" -- so the hardcoded lookup found nothing and refused with a
    // false "this project has no 3D model to read", even though the model
    // WAS loaded. This test stashes the SAME fixture document under a
    // non-legacy item id and drives the exact call chain SetupModal's bore
    // pick makes (resolveOwningModelItemId(geo) -> recognizeModelBodyHoles /
    // readModelBodyFaceFacts) with that id threaded through, proving the
    // owning item's own document is the one replayed.
    expect(typeof window).toBe('undefined')
    const fixture = loadFixture()
    const nonLegacyItemId = 'model-item-not-legacy'
    stashLoadedDocument(nonLegacyFixtureBytes(fixture, nonLegacyItemId), nonLegacyItemId)

    const verdicts = await recognizeModelBodyHoles('F3', nonLegacyItemId)
    const bore = verdicts.find((v) => v.params.diameter === 15)
    expect(bore, JSON.stringify(verdicts)).toBeDefined()
    expect(bore!.faceIds).toHaveLength(1)
    const faceStableId = bore!.faceIds[0]

    const facts = await readModelBodyFaceFacts('F3', faceStableId, nonLegacyItemId)
    expect(facts.snapshot.type).toBe('cylinder')
    expect(facts.snapshot.radius).toBeCloseTo(7.5, 6)
    expect(facts.snapshot.centroid[0]).toBeCloseTo(-24.895063688586024, 6)
    expect(facts.snapshot.centroid[1]).toBeCloseTo(0, 6)

    // Same downstream shape as the legacy-item test above: a real bore-centre
    // origin binding SetupModal would enable Save Setup from, not just a
    // settled promise. `geo` carries the non-legacy modelItemId a real
    // buildModelBodyGeometry row would (resolveOwningModelItemId(geo) is what
    // SetupModal's resolveBoreFaceOwner hands the call chain above), and the
    // Placement record is the non-legacy item's own (a real "New model" item
    // gets its own record, byte-identical shape to the legacy one -- world
    // placement resolution is a separate seam this WO does not touch).
    const geo = { ...boreGeometryRow(fixture), modelItemId: nonLegacyItemId }
    const placements: ModelItemPlacementRecord[] = fixture.modelItemPlacements.map((p) => ({
      ...p, modelItemId: nonLegacyItemId,
    }))
    const picked = resolveSetupBoreOriginPick(
      geo, 'F3', faceStableId, facts.snapshot, facts.verdicts, placements,
    )
    expect(picked.origin.x).toBeCloseTo(-24.8951, 3)
    expect(picked.origin.y).toBeCloseTo(0, 3)
    expect(picked.origin.z).toBeCloseTo(15, 3)
    const { originBinding } = picked
    if (originBinding.kind !== 'part_feature') {
      throw new Error(`expected a part_feature origin binding, got '${originBinding.kind}'`)
    }
    expect(originBinding.featureRef.kind).toBe('bore_center')
  }, 30_000)

  it('a body owned by a non-legacy Model Item is never satisfied by ANOTHER item\'s document', async () => {
    // Guards against a fix that "succeeds" by ignoring modelItemId and
    // falling through to whatever is stashed under the legacy slot -- stash
    // the fixture ONLY under a non-legacy id, then ask for it under the
    // legacy default. That must still refuse (there is genuinely nothing
    // under "legacy"), never silently resolve someone else's body.
    const fixture = loadFixture()
    stashLoadedDocument(fixtureDocumentBytes(fixture), 'model-item-not-legacy')
    await expect(recognizeModelBodyHoles('F3')).rejects.toThrow(/no 3D model to read/)
  })

  it('a genuine face-facts failure still refuses, loudly, and never names an errand', async () => {
    const fixture = loadFixture()
    stashLoadedDocument(fixtureDocumentBytes(fixture))

    // F3 itself regenerates cleanly (proven above) -- this face id is simply
    // not one of its live faces, so THIS is a genuine "cannot read that face"
    // refusal, not a kernel-mount refusal.
    await expect(readModelBodyFaceFacts('F3', 'F3:not-a-real-face')).rejects.toThrow(
      /Selected Model face "F3:not-a-real-face" is unavailable on body "F3"/,
    )
  }, 30_000)

  it('with no document at all, names the real cause instead of the removed errand', async () => {
    // Nothing stashed: collectDocumentArchive() has no bytes to replay at all.
    await expect(readModelBodyFaceFacts('F3', 'anything')).rejects.toThrow(
      /no 3D model to read/,
    )
    await expect(readModelBodyFaceFacts('F3', 'anything')).rejects.not.toThrow(
      /open the Model tab/,
    )
  })
})
