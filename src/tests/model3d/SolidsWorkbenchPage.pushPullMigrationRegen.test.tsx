// @vitest-environment jsdom
//
// WO UI-80-R3 criterion 2 -- EXECUTOR-TRUTH regeneration gate.
//
// The R2 blocker + preflight second-carrier defect were kernel-INDEPENDENT: they
// live in the migration (ownerId / toolFeatureId not rewired) meeting the executor
// (which resolves those carriers through lookupLiveBody). A DAG-string assertion
// cannot see them fire. This gate loads a legacy v3 document through the SAME
// path a real .camproject open takes (stashLoadedDocument -> loadDocumentArchive
// runs the v3->v4 migration -> a fresh SolidsWorkbenchPage mount consumes the seed
// via takePendingDocumentSeed), then re-runs the WHOLE chain through the REAL
// in-process occt-wasm kernel (fullResync) and asserts MEASURED GEOMETRY:
//   - the promoted pushPull tail's body is the PUSHED body (top at base+delta);
//   - a downstream boolean whose TOOL was the promoted owner consumes the PUSHED
//     tail -- its measured volume matches the pushed tool (top 15), NOT the
//     un-pushed owner (top 12), NOT a "tool has no live body" refusal;
//   - a downstream fillet whose OWNER was the promoted owner regenerates on the
//     pushed tail rather than failing "owner 'F1' has no live body".
//
// This is the auditor's exact scenario ("lookupLiveBody(p.ownerId) fails on a
// superseded F1") proven fixed against real geometry, not DAG strings. Mounting
// idiom mirrors SolidsWorkbenchPage.downstreamRegen.test.tsx:80 (render with
// createLocalGeomService) + the documentHolder seam int14ProjectDocument.test.ts
// drives at the holder level.
//
// FAILS-IF: revert the versioning.ts carrier-census rewire (drop ownerId or
// toolFeatureId from BODY_IDENTITY_PAYLOAD_CARRIERS) and the downstream consumer's
// carrier keeps naming the superseded owner -> lookupLiveBody returns undefined ->
// the boolean/fillet fails "has no live body" and the volume/handle assertions refuse.

// localStorage note: the jsdom broken-localStorage boundary guard that this
// suite originally imported directly (src/tests/model3d/localStoragePolyfill.ts,
// WO UI-80-R3) was promoted to a global vitest setupFile by WO INT-17A-R7
// (src/tests/setup/localStoragePolyfill.ts, registered in vite.config.ts
// test.setupFiles). vitest runs setupFiles to completion and only then
// imports this file's own module graph (@vitest/runner's chunk-hooks.js
// collectTests() awaits runSetupFiles(...) before awaiting
// runner.importFile(filepath, "collect")), so the persist store below still
// hydrates against a working localStorage with no per-suite import needed.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createDocumentArchive, stableStringify, loadDocumentArchive } from '../../doc/persist'
import { stashLoadedDocument, resetDocumentHolder } from '../../doc/documentHolder'
import { arrayBufferToBase64, base64ToArrayBuffer } from '../../lib/projectBinaries'
import { useCamStore } from '../../store'
import { FeatureDag } from '../../doc'
import { rectangleProfile } from '../../components/model3d/workbench/profileGeometry'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'

const fakeSceneRuntime: CreateSceneRuntime = () => createFakeSceneRuntime()

afterEach(cleanup)
beforeEach(() => resetDocumentHolder())

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

/** Serialize a dag to a document archive, then stamp the manifest back to a
 *  genuine pre-UI-80 v3 archive (schema 3, no pushPull) so loadDocumentArchive
 *  runs the real v3->v4 migration on load. */
function legacyV3Archive(dag: FeatureDag): Uint8Array {
  const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
  const files = unzipSync(archive)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  manifest.schemaVersion = 3
  files['manifest.json'] = strToU8(stableStringify(manifest))
  const zippable: Zippable = {}
  for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

/**
 * The preserved UI-80 binary fixture predates the canonical sketch-region
 * payload. Regenerate only that authored sketch field in memory so this test
 * continues to exercise the real project-open and v3 push/pull migration
 * boundaries without asking production versioning to migrate profile geometry.
 */
function withCanonicalSketchRegions(text: string): string {
  const outer = JSON.parse(text) as { document: string; [key: string]: unknown }
  const files = unzipSync(new Uint8Array(base64ToArrayBuffer(outer.document)))
  const document = JSON.parse(strFromU8(files['document.json'])) as {
    dag: { nodes: Array<{ kind: string; payload: Record<string, unknown> }> }
  }
  for (const node of document.dag.nodes) {
    if (node.kind !== 'sketch' || node.payload.profile === undefined) continue
    node.payload.regions = [node.payload.profile]
    delete node.payload.profile
  }
  files['document.json'] = strToU8(stableStringify(document))
  const archive = zipSync(files, ZIP_OPTIONS)
  const archiveBuffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer
  outer.document = arrayBufferToBase64(archiveBuffer)
  return JSON.stringify(outer)
}

function sketchNode(id: string, opts: { width: number; height: number; offset: number }) {
  return {
    id,
    kind: 'sketch' as const,
    consumes: [],
    payload: {
      name: `Sketch ${id}`,
      plane: 'xy',
      width: opts.width,
      height: opts.height,
      offset: opts.offset,
      regions: [rectangleProfile({ sketchId: id, plane: 'xy', ...opts })],
    },
  }
}

/** Mount a fresh page seeded from the stashed (migrated) document, wait for the
 *  hooks to install, then force a full kernel regen through the real executor. */
async function mountAndRegen(archive: Uint8Array): Promise<void> {
  stashLoadedDocument(archive)
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  await waitFor(() => expect(window.__solidsWorkbenchHooks).not.toBeUndefined(), { timeout: 20_000 })
  await hooks().fullResync(['SK1'])
}

/** Promoted pushPull node ids in the migrated dag (dag order). */
function pushPullNodeIds(): string[] {
  return hooks()
    .dag.nodeIds()
    .filter((id) => (hooks().dag.getNode(id)!.payload as { opType?: unknown }).opType === 'pushPull')
}

/** The single promoted pushPull node in the migrated dag. */
function pushPullTailId(): string {
  const ids = pushPullNodeIds()
  expect(ids).toHaveLength(1)
  return ids[0]
}

describe('WO UI-80-R3 C2: executor-truth regen after v3->v4 migration (toolFeatureId carrier)', () => {
  it('a downstream boolean whose TOOL was the promoted owner consumes the PUSHED tail (measured volume)', async () => {
    // Legacy v3: F1 (tool) = a 40x30 box, top pushed +3 (12 -> 15) by a faceOffset.
    // TB (target) = a 20x20 box z:[0,20] sitting entirely within F1's xy footprint.
    // A boolean removes the F1 tool from TB. In the legacy doc the tool's identity
    // rides payload.toolFeatureId=F1; after promotion F1 is superseded by the
    // pushPull tail, so the migration MUST retarget toolFeatureId to the tail.
    const dag = new FeatureDag()
    dag.insertNode(sketchNode('SK1', { width: 40, height: 30, offset: 0 }))
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: {
        opType: 'extrude', sketchId: 'SK1', distance: 12, direction: 'up', boolMode: 'newBody', name: 'Extrude F1',
        faceEdits: [{ featureKey: 'F1:XTR:SK1:capEnd', kind: 'faceOffset', delta: 3 }],
      },
    })
    dag.insertNode(sketchNode('SK2', { width: 20, height: 20, offset: 10 }))
    dag.insertNode({ id: 'TB', kind: 'feature', consumes: ['SK2'], payload: { opType: 'extrude', sketchId: 'SK2', distance: 20, direction: 'up', boolMode: 'newBody', name: 'Extrude TB' } })
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['TB', 'F1'],
      payload: { opType: 'boolean', boolOp: 'cut', targetFeatureId: 'TB', toolFeatureId: 'F1', name: 'Boolean F2' },
    })

    await mountAndRegen(legacyV3Archive(dag))
    const tail = pushPullTailId()

    // The promoted pushPull tail regenerated to the PUSHED body: top face at 15.
    await waitFor(() => expect(hooks().getBodyHandle(tail)).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().getBodyTopPoint(tail)!.z).toBeCloseTo(15, 1)

    // The boolean consumed the promoted tail as its tool (NOT the superseded F1):
    // status ok, a live body, and a MEASURED volume matching the PUSHED tool
    // (target 20x20x20 minus the 20x20 slab below z=15 = 20*20*5 = 2000). The
    // un-pushed owner (top 12) would leave 20*20*8 = 3200; a "no live body"
    // refusal would leave no body at all.
    await waitFor(() => expect(hooks().scheduler.statusOf('F2')).not.toBe('dirty'), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')
    const f2Body = hooks().getBodyHandle('F2')
    expect(f2Body).not.toBeUndefined()
    const vol = (await hooks().client.measure(f2Body!, 'volume')).value
    expect(vol).toBeCloseTo(2000, 0)
    // Guard the lineage claim explicitly: the un-pushed-owner volume is refused.
    expect(Math.abs(vol - 3200)).toBeGreaterThan(100)
  }, 120_000)
})

describe('WO UI-80-R3 C2: executor-truth regen after v3->v4 migration (ownerId carrier)', () => {
  it('a downstream shell whose OWNER was the promoted owner hollows the PUSHED tail (measured top face), not "owner has no live body"', async () => {
    // The R2 blocker's exact scenario: a downstream body op reads p.ownerId via
    // lookupLiveBody. Here a shell hollows the box by removing its top cap
    // (F1:XTR:SK1:capEnd -- a lineage-stable face preserved through the faceOffset,
    // confirmed live in the migrated element map). In the legacy doc the shell's
    // owner rides payload.ownerId=F1; after promotion F1 is superseded, so the
    // migration MUST retarget ownerId to the pushPull tail or the executor's
    // lookupLiveBody(p.ownerId) returns undefined and the shell fails "owner 'F1'
    // has no live body".
    const dag = new FeatureDag()
    dag.insertNode(sketchNode('SK1', { width: 40, height: 20, offset: 10 }))
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: {
        opType: 'extrude', sketchId: 'SK1', distance: 12, direction: 'up', boolMode: 'newBody', name: 'Extrude F1',
        faceEdits: [{ featureKey: 'F1:XTR:SK1:capEnd', kind: 'faceOffset', delta: 3 }],
      },
    })
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['F1'],
      payload: { opType: 'shell', ownerId: 'F1', removeFaces: ['F1:XTR:SK1:capEnd'], thickness: 2, name: 'Shell F2' },
    })

    await mountAndRegen(legacyV3Archive(dag))
    const tail = pushPullTailId()

    // The promoted pushPull tail regenerated to the PUSHED body (top at 15).
    await waitFor(() => expect(hooks().getBodyHandle(tail)).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().getBodyTopPoint(tail)!.z).toBeCloseTo(15, 1)

    // The shell resolved its owner (payload.ownerId, rewired to the tail by the
    // migration) to the live PUSHED body and hollowed it. MEASURED geometry: the
    // shelled body is a live open box whose walls still reach the PUSHED top rim
    // (z ~ 15) -- proving the shell ran on the pushed tail, not the un-pushed owner
    // (z ~ 12), and definitely not the "owner has no live body" refusal (no body).
    await waitFor(() => expect(hooks().scheduler.statusOf('F2')).not.toBe('dirty'), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')
    const f2Body = hooks().getBodyHandle('F2')
    expect(f2Body).not.toBeUndefined()
    // ownerId was rewired away from the superseded 'F1' to the promoted tail.
    expect((hooks().dag.getNode('F2')!.payload as { ownerId?: string }).ownerId).toBe(tail)
    expect(hooks().getBodyTopPoint('F2')!.z).toBeCloseTo(15, 1)
    // A hollow body has strictly less volume than the solid pushed box (40*20*15).
    const vol = (await hooks().client.measure(f2Body!, 'volume')).value
    expect(vol).toBeGreaterThan(0)
    expect(vol).toBeLessThan(12000)
  }, 120_000)
})

// ===========================================================================
// WO UI-80-R3 criterion 3 -- REAL-BOUNDARY fixture through the ACTUAL project-open
// path. The R2 MAJOR was that the "real .camproject" was an inner liencam-3d-zip
// renamed and fed straight to loadDocumentArchive, with a 42-byte placeholder body
// cache. This fixture is an OUTER JSON .camproject produced at base 05c53df8 by the
// REAL store save path (saveProjectToFile) with a REAL kernel BREP body cache, and
// it is loaded here through loadProjectFromFile (JSON.parse -> migrateProjectData ->
// stashLoadedDocument decodes + runs the v3->v4 migration) + a workbench mount that
// consumes the seed and regenerates through the real kernel.
//
//   fixture      : coordination/archive/evidence/UI-80/legacy-pushpull-real-r3.camproject
//                  (archived from coordination/evidence/UI-80/ by commit f031c59e8)
//   sha256       : 518e17c5a3bdc350e83d4420a450cba2a366eddb11abe4977117edf4fba64a98
//   generated by : base 05c53df8 via coordination/archive/evidence/UI-80/ui80R3FixtureGen.generator.ts
//   inner archive: document schemaVersion 3, real bodies/F1.brep (5626 bytes,
//                  "Open CASCADE Topology V4"), dag SK1->F1(2 faceOffset)->F2(fillet),
//                  rollback marker after F1.
//
// FAILS-IF: revert the versioning.ts carrier-census rewire and F2's payload.ownerId
// keeps naming the superseded owner -> the downstream fillet's owner fails to
// resolve to the pushed tail (topology/geometry assertions refuse).
// ===========================================================================
describe('WO UI-80-R3 C3: real-boundary .camproject through loadProjectFromFile + workbench mount', () => {
  it('opens a genuine v3 push/pull .camproject: promotes to a chained pushPull pair, rewires the downstream fillet, reconciles rollback, resolves lineage, regenerates measured geometry', async () => {
    const fixturePath = resolve(process.cwd(), 'src/tests/evidence/UI-80/legacy-pushpull-real-r3.camproject')
    const text = withCanonicalSketchRegions(readFileSync(fixturePath, 'utf8'))

    // THE REAL PROJECT-OPEN BOUNDARY: JSON.parse -> migrateProjectData ->
    // stashLoadedDocument (base64 decode -> loadDocumentArchive -> v3->v4 migration).
    useCamStore.getState().loadProjectFromFile(text)
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await waitFor(() => expect(window.__solidsWorkbenchHooks).not.toBeUndefined(), { timeout: 20_000 })

    // TOPOLOGY: the two faceOffset records promoted to two chained pushPull siblings;
    // no faceOffset survives on the owner F1 (AM2 single-format). (holeDiameter
    // preservation is covered separately in pushPullMigration.test.ts; this fixture
    // stays geometrically clean so the downstream chain regenerates.)
    const pp = pushPullNodeIds()
    expect(pp).toHaveLength(2)
    const ownerEdits = (hooks().dag.getNode('F1')!.payload.faceEdits ?? []) as Array<{ kind: string }>
    expect(ownerEdits.some((e) => e.kind === 'faceOffset')).toBe(false)

    // The chain: head consumes owner F1, tail consumes head (deltas 3 then 2).
    const byDelta = new Map(pp.map((id) => [(hooks().dag.getNode(id)!.payload as { delta: number }).delta, id]))
    const head = byDelta.get(3)!
    const tail = byDelta.get(2)!
    expect(head).toBeDefined()
    expect(tail).toBeDefined()
    expect(hooks().dag.getNode(head)!.consumes).toEqual(['F1'])
    expect(hooks().dag.getNode(tail)!.consumes).toEqual([head])
    // AM1: the face rides node.refs, not a raw string in payload.
    expect(hooks().dag.getNode(head)!.refs).toEqual([{ id: 'F1:XTR:SK1:capEnd', kind: 'single-face' }])
    expect((hooks().dag.getNode(head)!.payload as { featureKey?: unknown }).featureKey).toBeUndefined()

    // DOWNSTREAM CONSUMER (the R2 blocker + R3 census fix): the pre-existing fillet
    // consumes the chain TAIL and its payload.ownerId is rewired to the tail, NOT
    // the superseded owner F1.
    const f2 = hooks().dag.getNode('F2')!
    expect(f2.payload.opType).toBe('fillet')
    expect(f2.consumes).toEqual([tail])
    expect((f2.payload as { ownerId?: string }).ownerId).toBe(tail)
    expect((f2.payload as { ownerId?: string }).ownerId).not.toBe('F1')

    // ROLLBACK: chain spliced after the owner; the `after F1` marker remapped to the
    // tail so the committed push/pull stays applied and only the true downstream is
    // rolled back. (featureOrder is prefixed with the mount's genesis nodes -- origin
    // + the three base datum planes -- so compare only the document's own features.)
    const docOrder = hooks()
      .dag.featureOrder()
      .filter((id) => id !== 'origin' && !id.startsWith('datum:'))
    expect(docOrder).toEqual(['SK1', 'F1', head, tail, 'F2'])
    expect(hooks().dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: tail })
    expect(hooks().dag.rolledBackIds()).toEqual(['F2'])

    // LINEAGE: element-map history survived the load boundary, so the promoted face
    // ref resolves live (not a lost reference).
    const res = hooks().map.resolve('F1:XTR:SK1:capEnd', 'single-face')
    expect(res.status).toBe('exact')
    expect(res.boundTo).toContain('F1:XTR:SK1:capEnd')

    // GEOMETRY (executor-truth): regenerate the whole chain through the real kernel.
    // The pushPull chain re-runs so the un-rolled-back tail is the PUSHED body:
    // base 12 + 3 + 2 = 17 (measured, not a DAG string). The rollback marker sits
    // after the tail, so F2 stays rolled back and does not regenerate.
    await hooks().fullResync(['SK1'])
    await waitFor(() => expect(hooks().getBodyHandle(tail)).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf(tail)).toBe('ok')
    expect(hooks().getBodyTopPoint(tail)!.z).toBeCloseTo(17, 1)

    // WO UI-80-R4 (D3): "the real body cache survived the load boundary" -- an
    // assertion on the CACHE, not a stand-in. The prior assertion here was
    // `project.name.length > 0`, which cannot fail on the cache claim (a project
    // always has a name) and never touched the BREP. Reworded to what this test
    // actually proves: this test's regen genuinely RE-DERIVES F1 from the sketch
    // (fullResync(['SK1']) above replays both faceOffset->pushPull deltas -> top
    // 17), it does NOT restore from the cache -- so the honest, narrower claim is
    // that the fixture's REAL kernel BREP body cache is CARRIED ACROSS the
    // document-load boundary intact, even though the workbench rebuilds from the
    // dag rather than restoring it. Assert THAT on the cache itself: presence +
    // a geometric identity property of the DESERIALIZED cached body. Strictly
    // can-fail against the R2 42-byte placeholder (its bytes fail the header,
    // the length, and restoreBody+measure below).
    const innerArchive = new Uint8Array(base64ToArrayBuffer((JSON.parse(text) as { document: string }).document))
    const loaded = loadDocumentArchive(innerArchive)
    const f1Cache = loaded.bodyCaches.find((c) => c.bodyId === 'F1')
    expect(f1Cache).toBeDefined()
    expect(f1Cache!.path).toBe('bodies/F1.brep')
    // identity: a genuine Open CASCADE serialized solid, NOT the R2 42-byte placeholder.
    expect(f1Cache!.bytes.length).toBeGreaterThan(5000)
    expect(new TextDecoder().decode(f1Cache!.bytes.subarray(0, 40))).toContain('Open CASCADE Topology V4')
    // geometry: the cached bytes deserialize (real kernel) to the generator's real
    // PUSHED body -- blind 12 + the single +3 faceOffset it serialized = top 15,
    // volume 40*20*15 = 12000 -- a DISTINCT snapshot from the regenerated tail
    // (top 17, vol 13600), proving this reads the CACHE content, not the rebuild.
    // Copy into a genuine ArrayBuffer (Uint8Array.buffer is typed ArrayBufferLike,
    // which restoreBody's ArrayBuffer param rejects -- a build-only type error).
    const cachedBytes = new ArrayBuffer(f1Cache!.bytes.byteLength)
    new Uint8Array(cachedBytes).set(f1Cache!.bytes)
    const cachedBody = await hooks().client.restoreBody(cachedBytes, f1Cache!.elementMap)
    const cachedVol = (await hooks().client.measure(cachedBody, 'volume')).value
    expect(cachedVol).toBeCloseTo(12000, 0) // 40*20*15 pushed body (base 12 + the +3 the generator serialized)
  }, 120_000)
})
