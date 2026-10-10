// INT-IMPORT-EDIT stage 3 (multi-body STEP): the store action
// wrapImportedGeometryAsModelItem's FANOUT branch, driven through the REAL
// zustand store, IndexedDB step cache mocked to an in-memory map.
//
// Proves the multi-body STEP no longer refuses but fans out:
//   - solidCount > 1 -> ONE Model Item minted + opened (NOT a 'multi-body' refusal).
//   - the wrapped CAM row is marked pending (still format:'step', not duplicated).
//   - N FRESH cache copies are made (one per solid, independent lifetimes), the
//     source bytes left intact (undo-safe).
//   - the stashed seed carries ONE import node per solid, each with its bodyIndex.
//   - a whole-item placement is seeded from the row pose (no-jump for the assembly).
//   - one undo restores the pre-wrap row + drops the item + placement.
//   - an UNKNOWN solid count (no persisted count, no runtime payload) takes the
//     single-body path (one copy, one no-bodyIndex node) -- the executor's own
//     multi-body refusal is the named fallback there.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
let freshStepWriteOrdinal = 0
let gateFreshStepWriteOrdinal: number | null = null
let throwFreshStepWriteOrdinal: number | null = null
let stepWriteGate: Promise<void> | null = null
let announceStepWrite: ((key: string) => void) | null = null
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id: string, buf: ArrayBuffer) => {
    cache.set(id, buf)
    if (id === 'geo-asm') return
    freshStepWriteOrdinal++
    if (freshStepWriteOrdinal === throwFreshStepWriteOrdinal) {
      throw new Error(`cache write ${freshStepWriteOrdinal} failed after persistence`)
    }
    if (freshStepWriteOrdinal === gateFreshStepWriteOrdinal) {
      announceStepWrite?.(id)
      if (stepWriteGate !== null) await stepWriteGate
    }
  },
  loadCachedStep: async (id: string) => cache.get(id) ?? null,
  removeCachedStep: async (id: string) => { cache.delete(id) },
}))

const headlessReplayControl = vi.hoisted(() => ({
  failure: null as Error | null,
  gate: null as Promise<void> | null,
  announce: null as (() => void) | null,
}))
vi.mock('../../store/headlessModelBodyReplay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/headlessModelBodyReplay')>()
  return typedMock<typeof import('../../store/headlessModelBodyReplay')>({
    ...actual,
    replayImportedBodiesHeadless: async (_seed, modelItemId: string) => {
      headlessReplayControl.announce?.()
      if (headlessReplayControl.gate !== null) await headlessReplayControl.gate
      if (headlessReplayControl.failure !== null) throw headlessReplayControl.failure
      return { live: [], derived: [], modelItemId }
    },
  })
})

import { useCamStore } from '../../store'
import { resetDocumentHolder, takePendingDocumentSeed } from '../../doc/documentHolder'
import type { ImportedGeometry, SceneStock } from '../../types'

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function stepRow(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-asm', name: 'Assembly', filename: 'assembly.step', type: 'brep', format: 'step',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 }, size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 } },
    position: { x: 7, y: -3, z: 0 }, rotation: { x: 0, y: 0, z: 90 }, loaded: true,
    color: '#c0ffee', folderId: 'fold-1', solidCount: 3,
    ...over,
  }
}

const state = () => useCamStore.getState()
const geom = () => state().project.geometry
const items = () => state().project.modelItems ?? []

function resetStore(): void {
  resetDocumentHolder()
  cache.clear()
  freshStepWriteOrdinal = 0
  gateFreshStepWriteOrdinal = null
  throwFreshStepWriteOrdinal = null
  stepWriteGate = null
  announceStepWrite = null
  headlessReplayControl.failure = null
  headlessReplayControl.gate = null
  headlessReplayControl.announce = null
  cache.set('geo-asm', new Uint8Array([9, 8, 7, 6]).buffer)
  useCamStore.setState((s) => ({
    project: {
      ...s.project, setups: [], sceneStock: autoStock,
      geometry: [], modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
    },
    workspace: 'cam', activeModal: null, activeModelItemId: null, brepImportError: null,
    projectHistory: [], sketchHistory: [], canUndo: false,
  }))
}

describe('INT-IMPORT-EDIT stage 3: wrapImportedGeometryAsModelItem — multi-body fanout', () => {
  beforeEach(resetStore)

  it('a multi-body STEP wraps into ONE item, marks the row pending, opens the workspace (no refusal)', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const res = await state().wrapImportedGeometryAsModelItem('geo-asm')

    expect(res.ok).toBe(true)
    expect(state().brepImportError).toBeNull()          // no 'multi-body' refusal
    expect(items()).toHaveLength(1)                      // exactly ONE item for N solids
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(res.itemId)

    // The wrapped row is pending (still a step row, not duplicated).
    expect(geom()).toHaveLength(1)
    const row = geom()[0]
    expect(row.id).toBe('geo-asm')
    expect(row.format).toBe('step')
    expect(row.pendingModelItemId).toBe(res.itemId)
    expect(row.modelItemId).toBeUndefined()
  })

  it('makes N fresh cache copies (one per solid) and leaves the source bytes intact', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow({ solidCount: 3 })] } }))
    const keysBefore = new Set(cache.keys())
    await state().wrapImportedGeometryAsModelItem('geo-asm')
    const newKeys = [...cache.keys()].filter((k) => !keysBefore.has(k))
    expect(newKeys).toHaveLength(3)                       // one copy per solid
    expect(new Set(newKeys).size).toBe(3)                 // all distinct keys
    expect(newKeys).not.toContain('geo-asm')             // none reuse the source id
    expect(cache.get('geo-asm')).toBeDefined()           // source left intact (undo-safe)
  })

  it('stashes a seed with ONE import node per solid, each carrying its bodyIndex', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow({ solidCount: 3 })] } }))
    const res = await state().wrapImportedGeometryAsModelItem('geo-asm')
    const seed = takePendingDocumentSeed(res.itemId!)
    expect(seed).not.toBeNull()
    const dag = seed!.dag
    for (let i = 0; i < 3; i++) {
      const node = dag.getNode(`IMP${i + 1}`)
      expect(node, `IMP${i + 1}`).toBeDefined()
      expect(node!.kind).toBe('import')
      expect((node!.payload as { bodyIndex?: number }).bodyIndex).toBe(i)
    }
    // Solid 1 keeps the row's name; the rest are disambiguated.
    expect((dag.getNode('IMP1')!.payload as { name?: string }).name).toBe('Assembly')
    expect((dag.getNode('IMP2')!.payload as { name?: string }).name).toBe('Assembly (2)')
  })

  it('seeds a whole-item placement from the row pose (no-jump for the assembly)', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const res = await state().wrapImportedGeometryAsModelItem('geo-asm')
    const placement = (state().project.modelItemPlacements ?? []).find((p) => p.modelItemId === res.itemId)
    expect(placement?.position).toEqual({ x: 7, y: -3, z: 0 })
    expect(placement?.rotation).toEqual({ x: 0, y: 0, z: 90 })
  })

  it('one undo restores the pre-wrap row and drops the item + placement', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    await state().wrapImportedGeometryAsModelItem('geo-asm')
    expect(items()).toHaveLength(1)

    state().undo()
    const row = geom().find((g) => g.id === 'geo-asm')!
    expect(row.format).toBe('step')
    expect(row.pendingModelItemId).toBeUndefined()
    expect(items()).toHaveLength(0)
    expect(state().project.modelItemPlacements ?? []).toHaveLength(0)
  })

  it('an UNKNOWN solid count takes the single-body path (one copy, one no-bodyIndex node)', async () => {
    // No persisted solidCount and no runtime brep payload -> treat as single body.
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow({ solidCount: undefined })] } }))
    const keysBefore = new Set(cache.keys())
    const res = await state().wrapImportedGeometryAsModelItem('geo-asm')
    expect(res.ok).toBe(true)
    const newKeys = [...cache.keys()].filter((k) => !keysBefore.has(k))
    expect(newKeys).toHaveLength(1)                        // single copy
    const dag = takePendingDocumentSeed(res.itemId!)!.dag
    expect(dag.getNode('IMP1')).toBeDefined()
    expect(dag.getNode('IMP2')).toBeUndefined()           // exactly one import node
    expect((dag.getNode('IMP1')!.payload as { bodyIndex?: number }).bodyIndex).toBeUndefined()
  })

  it('stale replacement after the second body copy releases every partial fresh key', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    let releaseWrite!: () => void
    let markWriteStarted!: (key: string) => void
    stepWriteGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const writeStarted = new Promise<string>((resolve) => { markWriteStarted = resolve })
    announceStepWrite = markWriteStarted
    gateFreshStepWriteOrdinal = 2

    const pending = state().wrapImportedGeometryAsModelItem('geo-asm')
    await writeStarted
    expect([...cache.keys()].filter((key) => key !== 'geo-asm')).toHaveLength(2)

    state().newProject()
    cache.set('geo-asm', new Uint8Array([4, 3, 2, 1]).buffer)
    useCamStore.setState({ brepImportError: 'replacement sentinel' })
    const replacementSnapshot = JSON.stringify(state().project)

    releaseWrite()
    const result = await pending
    expect(result).toEqual({ ok: false, reason: 'project-replaced' })
    expect([...cache.keys()]).toEqual(['geo-asm'])
    expect(JSON.stringify(state().project)).toBe(replacementSnapshot)
    expect(state().brepImportError).toBe('replacement sentinel')
  })

  it('a cache write that throws after persistence releases all partial multi-body copies', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    throwFreshStepWriteOrdinal = 2

    await expect(state().wrapImportedGeometryAsModelItem('geo-asm'))
      .rejects.toThrow('cache write 2 failed after persistence')

    expect([...cache.keys()]).toEqual(['geo-asm'])
    expect(items()).toHaveLength(0)
    expect(state().workspace).toBe('cam')
  })

  it('headless replay failure releases every fresh body cache key before refusing', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    headlessReplayControl.failure = new Error('forced replay failure')

    const result = await state().wrapImportedGeometryAsModelItem('geo-asm', { headless: true })

    expect(result).toEqual({ ok: false, reason: 'headless-split-failed' })
    expect([...cache.keys()]).toEqual(['geo-asm'])
    expect(items()).toHaveLength(0)
    expect(state().brepImportError).toContain('forced replay failure')
  })

  it('stale replacement during headless replay releases keys without mutating replacement state', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    let releaseReplay!: () => void
    let markReplayStarted!: () => void
    headlessReplayControl.gate = new Promise<void>((resolve) => { releaseReplay = resolve })
    const replayStarted = new Promise<void>((resolve) => { markReplayStarted = resolve })
    headlessReplayControl.announce = markReplayStarted

    const pending = state().wrapImportedGeometryAsModelItem('geo-asm', { headless: true })
    await replayStarted
    expect([...cache.keys()].filter((key) => key !== 'geo-asm')).toHaveLength(3)

    state().newProject()
    cache.set('geo-asm', new Uint8Array([1, 1, 2, 3]).buffer)
    useCamStore.setState({ brepImportError: 'replacement sentinel' })
    const replacementSnapshot = JSON.stringify(state().project)

    releaseReplay()
    const result = await pending
    expect(result).toEqual({ ok: false, reason: 'project-replaced' })
    expect([...cache.keys()]).toEqual(['geo-asm'])
    expect(JSON.stringify(state().project)).toBe(replacementSnapshot)
    expect(state().brepImportError).toBe('replacement sentinel')
  })
})
