// IMPORT-MULTIBODY-CHOICE (Operator Q-76): the store's promise-based multi-body
// import choice (requestMultiBodyImportChoice / resolveMultiBodyImportChoice) and
// the re-choose action (reopenMultiBodyImportChoice), driven through the REAL
// zustand store with the IndexedDB step cache mocked to an in-memory map (same
// harness as wrapMultiBodyStep.intImportEdit.test.ts).
//
// Operator ruled the user decides how a multi-body STEP lands -- "how it should work
// may depend upon the users needs not the software's expectations." These pins
// prove:
//   - request opens the choice (state reflects it, pre-selected currentMode), and
//     resolve settles the awaited promise with the chosen mode + clears state.
//   - a second request supersedes the first, resolving the first with ITS OWN
//     currentMode (no hung awaiter, no silent mode change).
//   - re-choose preselects the row's STORED pick (edit-reuses-original-UI), and
//     'individual' runs the SAME wrap fan-out the import flow uses while 'combined'
//     leaves the single row and persists the pick.
//   - re-choose is a no-op on a single-body / already-split / non-step row.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedStep: async (id: string) => cache.get(id) ?? null,
  removeCachedStep: async (id: string) => { cache.delete(id) },
}))

import { useCamStore } from '../../store'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService } from '../../geom'
import { __setHeadlessReplayClientFactoryForTests } from '../../store/headlessModelBodyReplay'
import type { ImportedGeometry, SceneStock } from '../../types'

// IMPORT-FANOUT-HEADLESS: re-choosing "One item per body" now splits headlessly
// (no Model-workspace hop), so the 'individual' re-choose exercises the real
// occt-wasm kernel. Fresh fixture bytes per read (importStep detaches the
// buffer); the two disjoint boxes are the same fixture importExecutorBodyIndex uses.
const twoSolidsBytes = readFileSync(resolve(process.cwd(), 'test_fixtures/brep/fix_two_solids.step'))
function fixtureArrayBuffer(): ArrayBuffer {
  return twoSolidsBytes.buffer.slice(twoSolidsBytes.byteOffset, twoSolidsBytes.byteOffset + twoSolidsBytes.byteLength)
}

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function stepRow(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-asm', name: 'Assembly', filename: 'assembly.step', type: 'brep', format: 'step',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 }, size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    solidCount: 3,
    ...over,
  }
}

const state = () => useCamStore.getState()
const geom = () => state().project.geometry
const items = () => state().project.modelItems ?? []

function resetStore(): void {
  resetDocumentHolder()
  cache.clear()
  cache.set('geo-asm', new Uint8Array([9, 8, 7, 6]).buffer)
  useCamStore.setState((s) => ({
    project: {
      ...s.project, setups: [], sceneStock: autoStock,
      geometry: [], modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
    },
    workspace: 'cam', activeModal: null, activeModelItemId: null, brepImportError: null,
    multiBodyImportChoice: null,
    projectHistory: [], sketchHistory: [], canUndo: false,
  }))
}

describe('IMPORT-MULTIBODY-CHOICE: request / resolve', () => {
  beforeEach(resetStore)

  it('request opens the choice with the pre-selected currentMode; resolve settles the promise and clears it', async () => {
    const p = state().requestMultiBodyImportChoice({
      geoId: 'geo-asm', name: 'Assembly', bodyCount: 3, currentMode: 'combined',
    })
    // The set() ran synchronously before the returned promise's await point.
    expect(state().multiBodyImportChoice).toEqual({
      geoId: 'geo-asm', name: 'Assembly', bodyCount: 3, currentMode: 'combined',
    })

    state().resolveMultiBodyImportChoice('individual')
    await expect(p).resolves.toBe('individual')
    expect(state().multiBodyImportChoice).toBeNull()
  })

  it('a second request supersedes the first, resolving the first with its OWN currentMode', async () => {
    const first = state().requestMultiBodyImportChoice({
      geoId: 'geo-a', name: 'A', bodyCount: 2, currentMode: 'individual',
    })
    const second = state().requestMultiBodyImportChoice({
      geoId: 'geo-b', name: 'B', bodyCount: 4, currentMode: 'combined',
    })
    // First awaiter must not hang; it resolves with the FIRST request's own
    // currentMode ('individual'), never a hardcoded default.
    await expect(first).resolves.toBe('individual')
    expect(state().multiBodyImportChoice?.geoId).toBe('geo-b')

    state().resolveMultiBodyImportChoice('combined')
    await expect(second).resolves.toBe('combined')
  })
})

describe('IMPORT-MULTIBODY-CHOICE: reopenMultiBodyImportChoice (re-choose)', () => {
  beforeEach(() => {
    resetStore()
    __setHeadlessReplayClientFactoryForTests(createLocalGeomService)
  })
  afterEach(() => { __setHeadlessReplayClientFactoryForTests(null) })

  it('preselects the stored pick, and "individual" splits HEADLESSLY in place (edit-reuses-original-UI, no workspace hop)', async () => {
    // A real 2-body STEP so the headless re-split actually materializes rows.
    cache.set('geo-asm', fixtureArrayBuffer())
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [stepRow({ solidCount: 2, multiBodyMode: 'individual' })] },
    }))
    const p = state().reopenMultiBodyImportChoice('geo-asm')
    // Opened preselected to the row's stored pick.
    expect(state().multiBodyImportChoice?.currentMode).toBe('individual')
    expect(state().multiBodyImportChoice?.bodyCount).toBe(2)

    state().resolveMultiBodyImportChoice('individual')
    await p
    // Split headlessly: one Model Item minted, the row ADOPTED as body 1 (id
    // preserved, format flipped, pending cleared), solid 2 appended -- and the
    // app STAYED in CAM (no detour to the Model workspace).
    expect(items()).toHaveLength(1)
    expect(geom().filter((g) => g.format === 'model')).toHaveLength(2)
    const row = geom().find((g) => g.id === 'geo-asm')!
    expect(row.format).toBe('model')
    expect(row.pendingModelItemId).toBeUndefined()
    expect(row.modelBody?.ref.bodyId).toBe('IMP1')
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()
  }, 120_000)

  it('"combined" leaves the single row and persists the pick, no fan-out', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const p = state().reopenMultiBodyImportChoice('geo-asm')
    // No stored pick -> defaults to 'combined' preselect.
    expect(state().multiBodyImportChoice?.currentMode).toBe('combined')

    state().resolveMultiBodyImportChoice('combined')
    await p
    expect(items()).toHaveLength(0)
    expect(geom()).toHaveLength(1)
    expect(geom()[0].multiBodyMode).toBe('combined')
  })

  it('is a no-op on a single-body STEP row (never opens the choice)', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow({ solidCount: 1 })] } }))
    await state().reopenMultiBodyImportChoice('geo-asm')
    expect(state().multiBodyImportChoice).toBeNull()
    expect(items()).toHaveLength(0)
  })

  it('is a no-op on a non-step row', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [stepRow({ format: 'stl', solidCount: undefined })] },
    }))
    await state().reopenMultiBodyImportChoice('geo-asm')
    expect(state().multiBodyImportChoice).toBeNull()
  })
})
