// @vitest-environment jsdom
//
// IMPORT-FANOUT-HEADLESS: the outcome-equivalence pin + the headless flow.
//
// The mission is that choosing "One item per body" at import lands N CAM rows
// WITHOUT the Model-workspace round trip, producing rows IDENTICAL to what the
// round-trip path produces. Everything downstream of syncModelBodies is shared
// code, so the equivalence reduces to ONE seam: does the headless replay produce
// the SAME ModelBodySyncInput the workbench's syncCamModelBodies would?
//
//   PIN 1 (equivalence, RED->GREEN): mount the REAL SolidsWorkbenchPage on the
//   fan-out seed (the round-trip path, importExecutorBodyIndex's idiom) and SPY
//   the exact ModelBodySyncInput it hands syncModelBodies; independently run the
//   headless replay on the SAME seed; assert the two inputs are equivalent
//   (same live bodyIds+names, same derived bodyIds + stableIds + face ids +
//   bbox). Break the headless replay (e.g. drop a body / wrong id) and this goes
//   RED.
//
//   PIN 2 (headless flow): drive the real store's headless wrap end to end and
//   assert the rows adopt+append correctly AND the app STAYS in CAM (workspace
//   never flips to 'part', activeModelItemId stays null) -- the no-detour claim.
//
//   PIN 3 (fail loud, ADR-0003): a headless split whose STEP bytes are missing
//   refuses BY NAME and leaves the combined row untouched (no half-split zombie).
//
// Same real in-process occt-wasm kernel (createLocalGeomService) both paths use;
// only the IndexedDB STEP byte cache is faked -- the one seam with no node
// equivalent, exactly as importExecutorBodyIndex / the store wrap tests fake it.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'

const twoSolidsBytes = readFileSync(resolve(process.cwd(), 'test_fixtures/brep/fix_two_solids.step'))
function fixtureArrayBuffer(): ArrayBuffer {
  return twoSolidsBytes.buffer.slice(twoSolidsBytes.byteOffset, twoSolidsBytes.byteOffset + twoSolidsBytes.byteLength)
}
// A togglable cache: PIN 3 flips it to "bytes gone" to prove the fail-loud path.
let cacheReturnsBytes = true
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async () => {},
  loadCachedStep: async (_id: string) => (cacheReturnsBytes ? fixtureArrayBuffer() : null),
  removeCachedStep: async () => {},
}))

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { buildMultiBodyImportedStepModelArchive } = await import('../../doc/promoteImportedStepModel')
const { stashLoadedDocument, resetDocumentHolder } = await import('../../doc/documentHolder')
const { loadDocumentArchive } = await import('../../doc/persist')
const { useCamStore } = await import('../../store')
const {
  replayImportedBodiesHeadless,
  __setHeadlessReplayClientFactoryForTests,
} = await import('../../store/headlessModelBodyReplay')
const { createFakeSceneRuntime } = await import('../../tests/model3d/fakeSceneRuntime')

import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { ModelBodySyncInput } from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry } from '../../types'

const fakeSceneRuntime: CreateSceneRuntime = () => createFakeSceneRuntime()

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function twoBodySeed(): Uint8Array {
  return buildMultiBodyImportedStepModelArchive([
    { fileName: 'fix_two_solids.step', cacheKey: 'k-0', name: 'Assembly', bodyIndex: 0 },
    { fileName: 'fix_two_solids.step', cacheKey: 'k-1', name: 'Assembly (2)', bodyIndex: 1 },
  ])
}

/** The load-bearing, tessellation-independent identity of a sync input: the
 *  body ids + names (row identity), the stable ids (pick bindings), and the
 *  face-id set + bbox (the persisted display shape) -- everything the mission's
 *  "same row shapes / ids-stability / bindings" clause names. Raw vertex arrays
 *  and the version counter are tessellation artifacts, not row identity. */
function fingerprint(input: ModelBodySyncInput) {
  return {
    live: [...input.live].sort((a, b) => a.bodyId.localeCompare(b.bodyId))
      .map((b) => ({ bodyId: b.bodyId, name: b.name })),
    derived: [...input.derived].sort((a, b) => a.bodyId.localeCompare(b.bodyId)).map((d) => ({
      bodyId: d.bodyId,
      stableIds: [...d.stableIds].sort(),
      faceIds: [...(d.display.faceIds ?? [])].sort(),
      bbox: {
        min: d.display.bbox.min.map((v) => Math.round(v * 1000) / 1000),
        max: d.display.bbox.max.map((v) => Math.round(v * 1000) / 1000),
      },
    })),
  }
}

afterEach(() => {
  cleanup()
  __setHeadlessReplayClientFactoryForTests(null)
  cacheReturnsBytes = true
})
beforeEach(() => {
  resetDocumentHolder()
  useCamStore.getState().newProject()
  cacheReturnsBytes = true
  __setHeadlessReplayClientFactoryForTests(createLocalGeomService)
})

describe('IMPORT-FANOUT-HEADLESS: headless split == workspace-round-trip split', () => {
  it('PIN 1: the headless replay produces the SAME ModelBodySyncInput the workbench mount does', async () => {
    const seed = twoBodySeed()

    // --- Path A: the round-trip path. Mount the real workbench on the seed and
    // capture the exact input it hands syncModelBodies. ---
    const captured: ModelBodySyncInput[] = []
    const originalSync = useCamStore.getState().syncModelBodies
    useCamStore.setState({
      syncModelBodies: (input: ModelBodySyncInput) => {
        captured.push(input)
        originalSync(input)
      },
    })
    stashLoadedDocument(seed)
    render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: fakeSceneRuntime }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await waitFor(() => expect(window.__solidsWorkbenchHooks).not.toBeUndefined(), { timeout: 20_000 })
    await hooks().fullResync(['IMP1', 'IMP2'])
    await waitFor(() => expect(captured.some((i) => i.live.length === 2 && i.derived.length === 2)).toBe(true), { timeout: 30_000 })
    const workbenchInput = captured.find((i) => i.live.length === 2 && i.derived.length === 2)!
    useCamStore.setState({ syncModelBodies: originalSync })
    cleanup()

    // --- Path B: the headless replay on the SAME seed bytes. ---
    const headlessInput = await replayImportedBodiesHeadless(
      loadDocumentArchive(seed),
      workbenchInput.modelItemId ?? 'legacy',
    )

    // Both surfaced the same two bodies (IMP1/IMP2) with the same names...
    expect(fingerprint(headlessInput).live).toEqual([
      { bodyId: 'IMP1', name: 'Assembly' },
      { bodyId: 'IMP2', name: 'Assembly (2)' },
    ])
    // ...and, at the load-bearing level, an equivalent derived payload: same
    // stable ids (pick bindings), same face-id set, same bbox. THIS is the pin.
    expect(fingerprint(headlessInput)).toEqual(fingerprint(workbenchInput))
  }, 180_000)

  it('PIN 1b (non-vacuous): a broken headless replay would FAIL the equivalence check', async () => {
    // Prove the fingerprint discriminates: a deliberately corrupted input (a
    // dropped body) is NOT equal to the honest headless output.
    const seed = twoBodySeed()
    const honest = await replayImportedBodiesHeadless(loadDocumentArchive(seed), 'legacy')
    const broken: ModelBodySyncInput = { ...honest, live: honest.live.slice(0, 1), derived: honest.derived.slice(0, 1) }
    expect(fingerprint(broken)).not.toEqual(fingerprint(honest))
  }, 120_000)
})

describe('IMPORT-FANOUT-HEADLESS: the real store flow lands rows in CAM with no detour', () => {
  /** Seat a still-combined multi-body STEP row exactly as importBrepGeometry
   *  would (format:'step', solidCount 2), so the headless wrap adopts it. */
  function seatCombinedRow(geoId: string): ImportedGeometry {
    const row: ImportedGeometry = {
      id: geoId, name: 'Assembly', filename: 'fix_two_solids.step', type: 'brep', format: 'step',
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 65, y: 20, z: 15 }, size: { x: 65, y: 20, z: 15 }, center: { x: 32.5, y: 10, z: 7.5 } },
      position: { x: 3, y: 4, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      color: '#8899aa', solidCount: 2,
    }
    useCamStore.getState().addGeometry(row)
    return row
  }

  it('PIN 2: headless wrap adopts solid 1 + appends solid 2, and STAYS in CAM (no workspace switch)', async () => {
    const geoId = crypto.randomUUID()
    seatCombinedRow(geoId)
    expect(useCamStore.getState().workspace).toBe('cam')

    const res = await useCamStore.getState().wrapImportedGeometryAsModelItem(geoId, { headless: true })
    expect(res.ok).toBe(true)

    const geo = useCamStore.getState().project.geometry
    const modelRows = geo.filter((g) => g.format === 'model')
    // Two body rows surfaced from one seed, no Model workspace ever opened.
    expect(modelRows).toHaveLength(2)
    // The combined row was ADOPTED in place as solid 1: id preserved (op/stock/
    // folder bindings survive), format flipped, pending marker cleared, pose
    // reset to identity (world pose now rides the item Placement).
    const adopted = geo.find((g) => g.id === geoId)!
    expect(adopted.format).toBe('model')
    expect(adopted.pendingModelItemId).toBeUndefined()
    expect(adopted.modelBody?.ref.bodyId).toBe('IMP1')
    expect(adopted.position).toEqual({ x: 0, y: 0, z: 0 })
    // No lingering combined step row.
    expect(geo.some((g) => g.format === 'step')).toBe(false)
    // THE no-detour guarantee: the app never left CAM for the Model workspace.
    expect(useCamStore.getState().workspace).toBe('cam')
    expect(useCamStore.getState().activeModelItemId).toBeNull()
    // No-jump: the item's whole-item placement was seeded from the row's pose.
    const placement = useCamStore.getState().project.modelItemPlacements?.find((p) => p.modelItemId === res.itemId)
    expect(placement?.position).toEqual({ x: 3, y: 4, z: 0 })
  }, 180_000)

  it('PIN 3 (fail loud): a headless split whose bytes are gone REFUSES by name and leaves the combined row untouched', async () => {
    const geoId = crypto.randomUUID()
    seatCombinedRow(geoId)
    cacheReturnsBytes = false // simulate the bytes gone between import and replay

    const res = await useCamStore.getState().wrapImportedGeometryAsModelItem(geoId, { headless: true })
    // Refused, by name, in the same brepImportError channel the import path uses
    // -- whether the preflight byte-check or the headless replay catches it, the
    // guarantee is: fail loud, no half-split zombie.
    expect(res.ok).toBe(false)
    expect(typeof res.reason).toBe('string')
    expect(useCamStore.getState().brepImportError).toMatch(/missing|re-import/i)
    // The row is untouched: still ONE combined step row, no model rows, no item.
    const geo = useCamStore.getState().project.geometry
    expect(geo.filter((g) => g.format === 'model')).toHaveLength(0)
    const combined = geo.find((g) => g.id === geoId)!
    expect(combined.format).toBe('step')
    expect(combined.pendingModelItemId).toBeUndefined()
    expect(useCamStore.getState().project.modelItems ?? []).toHaveLength(0)
    expect(useCamStore.getState().workspace).toBe('cam')
  }, 120_000)

  it('PIN 3b (fail loud, headless module): replayImportedBodiesHeadless refuses missing bytes BY NAME (ADR-0003)', async () => {
    // Directly exercise the headless replay's OWN fail-loud path: a well-formed
    // seed whose STEP bytes are gone must reject with a named HeadlessReplayError
    // (never silently produce a partial/empty split).
    const { HeadlessReplayError } = await import('../../store/headlessModelBodyReplay')
    cacheReturnsBytes = false
    const seed = twoBodySeed()
    await expect(replayImportedBodiesHeadless(loadDocumentArchive(seed), 'item-x'))
      .rejects.toThrowError(HeadlessReplayError)
    await expect(replayImportedBodiesHeadless(loadDocumentArchive(seed), 'item-x'))
      .rejects.toThrow(/missing from IndexedDB|Re-import/i)
  }, 120_000)
})
