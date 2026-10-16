// @vitest-environment jsdom
//
// WO INT-6A-R1 (audit majors, INT-6A.audit.json findings[1]/[2]): two component regressions the
// audit's own suggestedFix text asked for. stepCache.ts's real backing store is IndexedDB, which
// jsdom does not implement (no polyfill in this repo) -- mocked with an in-memory Map exactly like
// src/tests/store/projectBinaries.test.ts's own established precedent for this exact module, so what's
// under test is SolidsWorkbenchPage's OWN cache-key generation/lookup/eviction-deferral logic, not
// stepCache.ts's IndexedDB plumbing (unchanged by this WO, and separately covered by that file).
//
//  A. findings[1] -- the cache key is a per-import crypto.randomUUID() (node payload's `cacheKey`),
//     never the document-local DAG node id. Two independent workbench documents that both mint DAG node
//     id "IMP1" (nextId scans from 1 in every fresh dag) must land in TWO DIFFERENT store keys, and a
//     later regen replay on the FIRST document must still retrieve the FIRST document's own bytes even
//     after the SECOND document caches its own IMP1 under a real, distinct key. Must FAIL against
//     pre-R1 (node.id as the key): both cacheStep calls would target the literal string "IMP1" and the
//     second overwrites the first.
//
//  B. findings[2] -- deleting an import node no longer evicts its cached bytes immediately (that broke
//     Undo: a restored node could never regenerate). Bytes must survive an Undo (still loadable, replay
//     still succeeds), and are only actually evicted once the document is closed (this page's own
//     unmount) AND the node is still absent at that point (a since-restored node's bytes are correctly
//     left alone).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const { stepStore } = vi.hoisted(() => ({ stepStore: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, buf: ArrayBuffer) => { stepStore.set(id, buf) }),
  loadCachedStep: vi.fn(async (id: string) => stepStore.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepStore.delete(id) }),
}))

import { render, cleanup, fireEvent, within } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { loadCachedStep } from '../../lib/stepCache'

afterEach(cleanup)

function stepFile(bytes: number[], name = 'part.step'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' })
}

async function importStepFile(container: HTMLElement, bytes: number[], name = 'part.step'): Promise<void> {
  const input = container.querySelector('[data-testid="workbench-import-step-input"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [stepFile(bytes, name)] } })
  await waitFor(() => expect(within(container).getByTestId('feature-row-IMP1')).toBeTruthy())
}

/** Mirrors FeatureTree.delete.test.tsx's own real delete flow: Delete key on the row opens the
 *  confirm dialog, then the confirm button actually runs SolidsWorkbenchPage.handleDelete. */
async function deleteImp1(container: HTMLElement): Promise<void> {
  fireEvent.keyDown(within(container).getByTestId('feature-row-IMP1'), { key: 'Delete' })
  fireEvent.click(within(container).getByTestId('tree-delete-confirm-confirm'))
  await waitFor(() => expect(within(container).queryByTestId('feature-row-IMP1')).toBeNull())
}

describe('SolidsWorkbenchPage STEP-import cache lifecycle (WO INT-6A-R1)', () => {
  it('two documents that both mint DAG node id IMP1 get two DIFFERENT cache keys, and a replay on one never reads the other\'s bytes (findings[1])', async () => {
    const clientA = createFakeGeomClient({ importedBodies: [{ name: 'Body A' }] })
    const clientB = createFakeGeomClient({ importedBodies: [{ name: 'Body B' }] })

    const pageA = render(<SolidsWorkbenchPage createClient={() => clientA} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(pageA.container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const hooksA = window.__solidsWorkbenchHooks as SolidsWorkbenchHooks

    await importStepFile(pageA.container, [1, 1, 1, 1], 'plate-A.step')
    const cacheKeyA = hooksA.dag.getNode('IMP1')?.payload.cacheKey as string | undefined
    expect(typeof cacheKeyA).toBe('string')
    expect(cacheKeyA).not.toBe('IMP1')
    const importCallsAAfterFirstImport = clientA.importStepCalls.length
    // WO-2796 probes the solid count, disposes the probe, then replays the node.
    expect(importCallsAAfterFirstImport).toBe(2)

    // A second, INDEPENDENT document -- a fresh dag, so nextId mints "IMP1" again.
    const pageB = render(<SolidsWorkbenchPage createClient={() => clientB} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(pageB.container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const hooksB = window.__solidsWorkbenchHooks as SolidsWorkbenchHooks
    expect(hooksB).not.toBe(hooksA) // sanity: the global test seam really did move to document B

    await importStepFile(pageB.container, [2, 2, 2, 2], 'plate-B.step')
    const cacheKeyB = hooksB.dag.getNode('IMP1')?.payload.cacheKey as string | undefined
    expect(typeof cacheKeyB).toBe('string')
    expect(cacheKeyB).not.toBe('IMP1')

    // The heart of findings[1]: two real, independent random cache keys.
    expect(cacheKeyB).not.toBe(cacheKeyA)

    // Force a regen replay on DOCUMENT A (the same path a page reload/fullResync drives) -- if the
    // pre-fix node-id key were still in play, this would now load document B's bytes instead.
    await hooksA.fullResync(['IMP1'])
    await waitFor(() => expect(clientA.importStepCalls.length).toBe(importCallsAAfterFirstImport + 1))
    const replayedBytes = new Uint8Array(clientA.importStepCalls[clientA.importStepCalls.length - 1].bytes)
    expect([...replayedBytes]).toEqual([1, 1, 1, 1]) // document A's OWN bytes, never document B's [2,2,2,2]

    // Direct store proof, independent of the app's own read path: each key resolves to its own bytes.
    const bytesForA = new Uint8Array((await loadCachedStep(cacheKeyA!))!)
    const bytesForB = new Uint8Array((await loadCachedStep(cacheKeyB!))!)
    expect([...bytesForA]).toEqual([1, 1, 1, 1])
    expect([...bytesForB]).toEqual([2, 2, 2, 2])
  })

  it('deleting an import node keeps its cached bytes across Undo; Undo genuinely restores replay (findings[2])', async () => {
    const client = createFakeGeomClient({ importedBodies: [{ name: 'Body' }] })
    const page = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(page.container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const hooks = window.__solidsWorkbenchHooks as SolidsWorkbenchHooks

    await importStepFile(page.container, [9, 9, 9], 'plate.step')
    const cacheKey = hooks.dag.getNode('IMP1')?.payload.cacheKey as string

    await deleteImp1(page.container)

    // findings[2]'s own regression: bytes must still be there RIGHT AFTER delete (no immediate evict).
    expect(await loadCachedStep(cacheKey)).not.toBeNull()

    fireEvent.click(within(page.container).getByTestId('workbench-undo'))
    await waitFor(() => expect(within(page.container).getByTestId('feature-row-IMP1')).toBeTruthy())

    // Undo genuinely restores: a fresh replay of the resurrected node succeeds (bytes were never evicted).
    const callsBeforeReplay = client.importStepCalls.length
    await hooks.fullResync(['IMP1'])
    await waitFor(() => expect(hooks.scheduler.statusOf('IMP1')).not.toBe('failed'))
    expect(client.importStepCalls.length).toBeGreaterThan(callsBeforeReplay)
    expect(await loadCachedStep(cacheKey)).not.toBeNull()

    // Close the document (unmount) with the node LIVE (restored) -- its bytes must be kept, not swept.
    page.unmount()
    expect(await loadCachedStep(cacheKey)).not.toBeNull()
  })

  it('a delete that is never undone has its bytes reclaimed once the document closes (findings[2] doc-close flush)', async () => {
    const client = createFakeGeomClient({ importedBodies: [{ name: 'Body' }] })
    const page = render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(within(page.container).getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const hooks = window.__solidsWorkbenchHooks as SolidsWorkbenchHooks

    await importStepFile(page.container, [7, 7, 7], 'plate.step')
    const cacheKey = hooks.dag.getNode('IMP1')?.payload.cacheKey as string

    await deleteImp1(page.container)
    expect(await loadCachedStep(cacheKey)).not.toBeNull() // still there -- document still open

    page.unmount() // "document closes" -- the doc-close flush point
    await waitFor(async () => expect(await loadCachedStep(cacheKey)).toBeNull())
  })
})
