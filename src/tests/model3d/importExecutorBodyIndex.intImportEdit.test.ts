// @vitest-environment jsdom
//
// INT-IMPORT-EDIT stage 3 -- the workbench body executor's 'import' branch
// bodyIndex replay, driven through the REAL SolidsWorkbenchPage mount + the
// REAL in-process occt-wasm kernel (only the IndexedDB STEP byte cache is
// faked, the one seam with no node equivalent -- same seam the store wrap
// tests mock). Mount idiom mirrors SolidsWorkbenchPage.pushPullMigrationRegen
// .test.tsx: stashLoadedDocument(seed) -> render -> wait for hooks -> a real
// fullResync through the executor -> assert MEASURED geometry, not DAG strings.
//
// The seed is the exact bytes buildMultiBodyImportedStepModelArchive /
// buildImportedStepModelArchive mint (src/doc/promoteImportedStepModel.ts), so
// the import nodes replay byte-identically to a real multi-body STEP wrap.
//
// FIXTURE: test_fixtures/brep/fix_two_solids.step -- two DISJOINT boxes minted
// deterministically through the kernel (box A 30x20x10 = vol 6000 at the origin
// corner; box B 15x15x15 = vol 3375 at x:[50,65]) and exportStep([A,B])'d into
// ONE AP214 file with two MANIFOLD_SOLID_BREP products. importStep on it returns
// bodies.length === 2 (verified when the fixture was generated). The two
// distinct volumes let each import node PROVE which solid it actually adopted:
// bodyIndex 0 -> the 6000 box, bodyIndex 1 -> the 3375 box.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'

// The STEP byte cache: return the SAME 2-solid fixture for every cacheKey, so
// each import node re-imports the whole file and keeps only its own bodyIndex
// (exactly the production multi-body fanout: N nodes, one file, N indices).
const twoSolidsBytes = readFileSync(resolve(process.cwd(), 'test_fixtures/brep/fix_two_solids.step'))
function fixtureArrayBuffer(): ArrayBuffer {
  // Fresh copy per read -- the kernel consumes the buffer; a shared one across
  // two import nodes must not be detached by the first importStep.
  return twoSolidsBytes.buffer.slice(twoSolidsBytes.byteOffset, twoSolidsBytes.byteOffset + twoSolidsBytes.byteLength)
}
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async () => {},
  loadCachedStep: async (_id: string) => fixtureArrayBuffer(),
  removeCachedStep: async () => {},
}))

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { buildImportedStepModelArchive, buildMultiBodyImportedStepModelArchive } = await import('../../doc/promoteImportedStepModel')
const { stashLoadedDocument, resetDocumentHolder } = await import('../../doc/documentHolder')
const { useCamStore } = await import('../../store')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')

import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'

const fakeSceneRuntime: CreateSceneRuntime = () => createFakeSceneRuntime()

const VOL_BOX_A = 6000 // bodyIndex 0: 30x20x10
const VOL_BOX_B = 3375 // bodyIndex 1: 15x15x15

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

/** Reason text of a node's first error diagnostic (KERNEL_OP_FAILED carries its
 *  message under params.reason). */
function failedReason(id: string): string {
  const diags = hooks().scheduler.diagnosticsOf(id)
  const err = diags.find((d) => d.severity === 'error') ?? diags[0]
  const params = (err?.params ?? {}) as { reason?: unknown }
  return typeof params.reason === 'string' ? params.reason : ''
}

/** Mount a fresh page seeded from the stashed archive, wait for the hooks to
 *  install, then force a real kernel regen of the given roots through the
 *  executor's 'import' branch. */
async function mountAndRegen(archive: Uint8Array, roots: string[]): Promise<void> {
  stashLoadedDocument(archive)
  render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: fakeSceneRuntime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  await waitFor(() => expect(window.__solidsWorkbenchHooks).not.toBeUndefined(), { timeout: 20_000 })
  await hooks().fullResync(roots)
}

afterEach(cleanup)
beforeEach(() => {
  resetDocumentHolder()
  useCamStore.getState().newProject()
})

describe('INT-IMPORT-EDIT stage 3: import-node bodyIndex replay through the real executor', () => {
  it('a two-node bodyIndex seed yields ONE distinct body per node (IMP1 -> solid 0, IMP2 -> solid 1); ONE item surfaces both solids', async () => {
    const archive = buildMultiBodyImportedStepModelArchive([
      { fileName: 'fix_two_solids.step', cacheKey: 'k-0', name: 'Assembly', bodyIndex: 0 },
      { fileName: 'fix_two_solids.step', cacheKey: 'k-1', name: 'Assembly (2)', bodyIndex: 1 },
    ])
    await mountAndRegen(archive, ['IMP1', 'IMP2'])

    // Each node adopted exactly one body, and they are DISTINCT handles.
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
    await waitFor(() => expect(hooks().getBodyHandle('IMP2')).not.toBeUndefined(), { timeout: 30_000 })
    const h1 = hooks().getBodyHandle('IMP1')!
    const h2 = hooks().getBodyHandle('IMP2')!
    expect(h1).not.toBe(h2)
    expect(hooks().scheduler.statusOf('IMP1')).toBe('ok')
    expect(hooks().scheduler.statusOf('IMP2')).toBe('ok')

    // MEASURED proof each node adopted its OWN indexed solid, not a shared
    // bodies[0]: IMP1 is the 6000 box, IMP2 is the 3375 box.
    const v1 = (await hooks().client.measure(h1, 'volume')).value
    const v2 = (await hooks().client.measure(h2, 'volume')).value
    expect(v1).toBeCloseTo(VOL_BOX_A, 0)
    expect(v2).toBeCloseTo(VOL_BOX_B, 0)
    // Non-vacuous: the two nodes did NOT resolve to the same solid.
    expect(Math.abs(v1 - v2)).toBeGreaterThan(1000)

    // The workbench surfaces BOTH solids from this ONE seeded item: two body
    // rows in the tree, and two format:'model' rows in the CAM store.
    await waitFor(() => expect(screen.getAllByTestId(/^body-row-/)).toHaveLength(2), { timeout: 30_000 })
    const modelRows = useCamStore.getState().project.geometry.filter((g) => g.format === 'model')
    expect(modelRows).toHaveLength(2)
    const surfacedBodyIds = new Set(modelRows.map((g) => g.modelBody!.ref.bodyId))
    expect(surfacedBodyIds).toEqual(new Set(['IMP1', 'IMP2']))
  }, 120_000)

  it('a bodyIndex that outruns the file REFUSES by name (solid N is missing) and leaves no live body', async () => {
    // Index 5 on a 2-solid file: out of range. This is the "the STEP was
    // re-imported with fewer solids after a reload" guard.
    const archive = buildMultiBodyImportedStepModelArchive([
      { fileName: 'fix_two_solids.step', cacheKey: 'k-oob', name: 'Assembly', bodyIndex: 5 },
    ])
    await mountAndRegen(archive, ['IMP1'])

    await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('failed'), { timeout: 30_000 })
    // Refused BY NAME: names the file, the requested solid (5 -> "solid 6"),
    // and the real count now in the file.
    const reason = failedReason('IMP1')
    expect(reason).toContain('fix_two_solids.step')
    expect(reason).toContain('solid 6 is missing')
    expect(reason).toContain('2 solid(s)')
    expect(reason).toContain('Re-import the file')
    // No handle leaked for the refused node; nothing surfaced to CAM.
    expect(hooks().getBodyHandle('IMP1')).toBeUndefined()
    expect(useCamStore.getState().project.geometry.filter((g) => g.format === 'model')).toHaveLength(0)
  }, 120_000)

  it('a NO-bodyIndex import node on a multi-body file still REFUSES multi-body by name (INT-6A back-compat)', async () => {
    // buildImportedStepModelArchive mints a single import node with NO bodyIndex
    // -- the original one-body-per-node contract, which refuses a multi-body
    // file rather than silently keeping bodies[0].
    const archive = buildImportedStepModelArchive({ fileName: 'fix_two_solids.step', cacheKey: 'k-nb', name: 'Assembly' })
    await mountAndRegen(archive, ['IMP1'])

    await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('failed'), { timeout: 30_000 })
    const reason = failedReason('IMP1')
    expect(reason).toContain('fix_two_solids.step')
    expect(reason).toContain('contains 2 bodies')
    expect(reason).toContain('import each separately')
    expect(hooks().getBodyHandle('IMP1')).toBeUndefined()
    expect(useCamStore.getState().project.geometry.filter((g) => g.format === 'model')).toHaveLength(0)
  }, 120_000)
})
