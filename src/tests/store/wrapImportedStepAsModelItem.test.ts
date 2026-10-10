// GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1: the store action
// wrapImportedGeometryAsModelItem, driven through the REAL zustand store
// (promoteSketchToModel.geoUnifyStage3 pattern), with the IndexedDB step cache
// mocked to an in-memory map (the one seam with no node equivalent).
//
// Proves plan sec 2 steps 1-6 at the store level:
//   - happy path: a single-body STEP row is marked pendingModelItemId (NOT
//     modelItemId), a new Model Item is minted, a seed doc stashed + consumable
//     once, the workspace opens on the item, the row is NOT duplicated.
//   - cache copy: the bytes are copied under a FRESH key (not the geo id).
//   - placement seed: a whole-item placement is seeded from the STEP row's pose
//     (no-jump), so ours wins over syncModelBodies' identity seed.
//   - refusals (loud, named, NO mutation): STL, non-STEP, nest seed, missing
//     bytes, multi-body (persisted count).
//   - undo: one Ctrl+Z restores the pre-wrap STEP row (pending cleared) and
//     drops the item + placement.
//   - repeated/overlapping invocation of the SAME wrap is single-flight and
//     reopens the one pending item instead of duplicating conversion.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

// The only seam with no node equivalent: the IndexedDB STEP byte cache.
const cache = new Map<string, ArrayBuffer>()
let stepLoadGate: Promise<void> | null = null
let announceStepLoad: (() => void) | null = null
let stepWriteGate: Promise<void> | null = null
let announceStepWrite: ((key: string) => void) | null = null
let gateNextFreshStepWrite = false
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id: string, buf: ArrayBuffer) => {
    cache.set(id, buf)
    if (id !== 'geo-step' && gateNextFreshStepWrite) {
      gateNextFreshStepWrite = false
      announceStepWrite?.(id)
      if (stepWriteGate !== null) await stepWriteGate
    }
  },
  loadCachedStep: async (id: string) => {
    announceStepLoad?.()
    if (stepLoadGate !== null) await stepLoadGate
    return cache.get(id) ?? null
  },
  removeCachedStep: async (id: string) => { cache.delete(id) },
}))

import { useCamStore } from '../../store'
import { resetDocumentHolder, takePendingDocumentSeed } from '../../doc/documentHolder'
import type { ImportedGeometry, SceneStock } from '../../types'

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

/** A single-body imported STEP row (solidCount 1) with a seated pose + bytes. */
function stepRow(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-step', name: 'Bracket', filename: 'bracket.step', type: 'brep', format: 'step',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 }, size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 } },
    position: { x: 7, y: -3, z: 0 }, rotation: { x: 0, y: 0, z: 90 }, loaded: true,
    color: '#c0ffee', folderId: 'fold-1', solidCount: 1,
    ...over,
  }
}

const state = () => useCamStore.getState()
const geom = () => state().project.geometry
const items = () => state().project.modelItems ?? []
const rowById = (id: string) => geom().find((g) => g.id === id)

function resetStore(): void {
  resetDocumentHolder()
  cache.clear()
  stepLoadGate = null
  announceStepLoad = null
  stepWriteGate = null
  announceStepWrite = null
  gateNextFreshStepWrite = false
  cache.set('geo-step', new Uint8Array([1, 2, 3, 4]).buffer)
  useCamStore.setState((s) => ({
    project: {
      ...s.project, setups: [], sceneStock: autoStock,
      geometry: [], modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
    },
    workspace: 'cam', activeModal: null, activeModelItemId: null, brepImportError: null,
    projectHistory: [], sketchHistory: [], canUndo: false,
  }))
}

describe('GEO-UNIFY Stage 4: wrapImportedGeometryAsModelItem — happy path', () => {
  beforeEach(resetStore)

  it('marks the STEP row pending (not modelItemId), mints the item, opens it, stashes a seed once', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const res = await state().wrapImportedGeometryAsModelItem('geo-step')

    expect(res.ok).toBe(true)
    const itemId = res.itemId!
    expect(itemId).toBeTruthy()

    // Row NOT duplicated; it is the SAME row, now pending (still format:'step').
    expect(geom()).toHaveLength(1)
    const row = rowById('geo-step')!
    expect(row.format).toBe('step')
    expect(row.pendingModelItemId).toBe(itemId)
    expect(row.modelItemId).toBeUndefined()   // pending must NOT light up model-row UI

    // Item minted (named after the row), folder inherited, workspace opened.
    expect(items().map((m) => m.id)).toContain(itemId)
    expect(items().find((m) => m.id === itemId)?.name).toBe('Bracket')
    expect(items().find((m) => m.id === itemId)?.folderId).toBe('fold-1')
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(itemId)

    // Seed stashed against the item, consumable exactly once.
    expect(takePendingDocumentSeed(itemId)).not.toBeNull()
    expect(takePendingDocumentSeed(itemId)).toBeNull()
  })

  it('copies the STEP bytes under a FRESH cache key (decoupled from the geo id)', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const keysBefore = new Set(cache.keys())
    await state().wrapImportedGeometryAsModelItem('geo-step')
    const newKeys = [...cache.keys()].filter((k) => !keysBefore.has(k))
    expect(newKeys).toHaveLength(1)                 // exactly one copy made
    expect(newKeys[0]).not.toBe('geo-step')          // NOT the source geo id
    expect(cache.get('geo-step')).toBeDefined()      // original left intact (undo-safe)
  })

  it('seeds a whole-item placement from the STEP row pose (no-jump)', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const res = await state().wrapImportedGeometryAsModelItem('geo-step')
    const placement = (state().project.modelItemPlacements ?? []).find((p) => p.modelItemId === res.itemId)
    expect(placement).toBeDefined()
    expect(placement?.bodyId).toBeUndefined()        // whole-item, not body-filtered
    expect(placement?.position).toEqual({ x: 7, y: -3, z: 0 })
    expect(placement?.rotation).toEqual({ x: 0, y: 0, z: 90 })
  })
})

describe('GEO-UNIFY Stage 4: wrapImportedGeometryAsModelItem — named refusals (no mutation)', () => {
  beforeEach(resetStore)

  async function expectRefusal(row: ImportedGeometry | null, id: string, reason: string): Promise<void> {
    if (row) useCamStore.setState((s) => ({ project: { ...s.project, geometry: [row] } }))
    const before = JSON.stringify(state().project.geometry)
    const res = await state().wrapImportedGeometryAsModelItem(id)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe(reason)
    expect(items()).toHaveLength(0)                 // nothing minted
    expect(state().workspace).toBe('cam')           // no nav
    expect(state().brepImportError).toBeTruthy()     // named, visible (ADR-0003)
    expect(JSON.stringify(state().project.geometry)).toBe(before)  // no mutation
  }

  it('refuses a missing row by name', async () => {
    await expectRefusal(null, 'nope', 'not-found')
  })
  // STL is no longer refused here -- it routes to the prismatic-mesh wrap path
  // (covered by wrapImportedMeshAsModelItem.mshWiring.test.ts). Every OTHER
  // non-STEP/non-STL format still refuses by name as 'unsupported'.
  it('refuses an unsupported non-STEP/non-STL row (dxf) by name', async () => {
    await expectRefusal(stepRow({ format: 'dxf', filename: 'x.dxf', type: 'curves_2d' }), 'geo-step', 'unsupported')
  })
  it('refuses a nest seed copy by name', async () => {
    await expectRefusal(stepRow({ ownerNestId: 'nest-9' }), 'geo-step', 'nest-seed')
  })
  // A multi-body STEP is no longer refused here (INT-IMPORT-EDIT stage 3) -- it
  // FANS OUT into one Model Item per solid (covered by
  // wrapMultiBodyStep.intImportEdit.test.ts). Missing bytes / unsupported format
  // / nest seed still refuse by name.
  it('refuses when cached bytes are missing by name', async () => {
    cache.delete('geo-step')
    await expectRefusal(stepRow(), 'geo-step', 'missing-bytes')
  })
})

describe('GEO-UNIFY Stage 4: wrapImportedGeometryAsModelItem - undo + repeat safety', () => {
  beforeEach(resetStore)

  it('undo closes the removed item and redo restores both the wrap and its Model workspace', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const wrapped = await state().wrapImportedGeometryAsModelItem('geo-step')
    const itemId = wrapped.itemId!
    expect(items()).toHaveLength(1)

    state().undo()
    const row = rowById('geo-step')!
    expect(row.format).toBe('step')
    expect(row.pendingModelItemId).toBeUndefined()   // clean pre-wrap row
    expect(items()).toHaveLength(0)                   // item gone
    expect(state().project.modelItemPlacements ?? []).toHaveLength(0)  // placement gone
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()

    state().redo()
    expect(rowById('geo-step')?.pendingModelItemId).toBe(itemId)
    expect(items().map((item) => item.id)).toEqual([itemId])
    expect(state().project.modelItemPlacements ?? []).toHaveLength(1)
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(itemId)
  })

  it('overlapping invocation of the SAME wrap is refused by name and mints exactly one item', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const first = state().wrapImportedGeometryAsModelItem('geo-step')
    const second = state().wrapImportedGeometryAsModelItem('geo-step')
    const [a, b] = await Promise.all([first, second])

    expect(a.ok).toBe(true)
    expect(b).toEqual({ ok: false, reason: 'already-in-progress' })
    expect(items()).toHaveLength(1)
    expect(items()[0].id).toBe(a.itemId)
    expect(takePendingDocumentSeed(a.itemId!)).not.toBeNull()
  })

  it('invocation after the wrap committed but before first regen reopens the SAME pending item', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const first = await state().wrapImportedGeometryAsModelItem('geo-step')
    const historyAfterFirst = state().projectHistory.length
    const cacheKeysAfterFirst = [...cache.keys()].sort()

    const repeated = await state().wrapImportedGeometryAsModelItem('geo-step')

    expect(repeated).toEqual({ ok: true, itemId: first.itemId })
    expect(items()).toHaveLength(1)
    expect(state().projectHistory).toHaveLength(historyAfterFirst)
    expect([...cache.keys()].sort()).toEqual(cacheKeysAfterFirst)
  })

  it('project replacement during async preparation aborts without touching the new project or workspace', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    let releaseLoad!: () => void
    let markLoadStarted!: () => void
    stepLoadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    const loadStarted = new Promise<void>((resolve) => { markLoadStarted = resolve })
    announceStepLoad = markLoadStarted

    const pending = state().wrapImportedGeometryAsModelItem('geo-step')
    await loadStarted
    state().newProject()
    const replacementId = state().project.id
    const replacementSnapshot = JSON.stringify(state().project)

    releaseLoad()
    const result = await pending
    stepLoadGate = null
    announceStepLoad = null

    expect(result).toEqual({ ok: false, reason: 'project-replaced' })
    expect(state().project.id).toBe(replacementId)
    expect(JSON.stringify(state().project)).toBe(replacementSnapshot)
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()
    expect(state().brepImportError).toBeNull()

    // The stale request's finally block released the single-flight lock.
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow()] } }))
    const retry = await state().wrapImportedGeometryAsModelItem('geo-step')
    expect(retry.ok).toBe(true)
  })

  it('a replacement project can wrap the same geo id while the stale cache write is pending', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepRow({ name: 'Old bracket' })] } }))
    let releaseWrite!: () => void
    let markWriteStarted!: (key: string) => void
    stepWriteGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const writeStarted = new Promise<string>((resolve) => { markWriteStarted = resolve })
    announceStepWrite = markWriteStarted
    gateNextFreshStepWrite = true

    const staleAttempt = state().wrapImportedGeometryAsModelItem('geo-step')
    const staleOwnedKey = await writeStarted
    expect(cache.has(staleOwnedKey)).toBe(true) // write landed before its await resumed

    state().newProject()
    cache.set('geo-step', new Uint8Array([5, 6, 7, 8]).buffer)
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [stepRow({ name: 'Replacement bracket' })] },
      brepImportError: null,
    }))

    // Hold the replacement's own fresh write too. It must acquire a distinct
    // project-scoped lock even though the old same-id request is still pending.
    let releaseReplacementWrite!: () => void
    let markReplacementWriteStarted!: (key: string) => void
    stepWriteGate = new Promise<void>((resolve) => { releaseReplacementWrite = resolve })
    const replacementWriteStarted = new Promise<string>((resolve) => { markReplacementWriteStarted = resolve })
    announceStepWrite = markReplacementWriteStarted
    gateNextFreshStepWrite = true
    const replacementAttempt = state().wrapImportedGeometryAsModelItem('geo-step')
    const replacementOwnedKey = await replacementWriteStarted

    releaseWrite()
    const staleResult = await staleAttempt

    expect(staleResult).toEqual({ ok: false, reason: 'project-replaced' })
    expect(cache.has(staleOwnedKey)).toBe(false) // stale attempt released only its fresh copy
    expect(cache.has(replacementOwnedKey)).toBe(true)

    // Old cleanup must not clear the replacement's still-live lock.
    const duplicate = await state().wrapImportedGeometryAsModelItem('geo-step')
    expect(duplicate).toEqual({ ok: false, reason: 'already-in-progress' })

    releaseReplacementWrite()
    const replacement = await replacementAttempt
    stepWriteGate = null
    announceStepWrite = null

    expect(replacement.ok).toBe(true)
    expect(items()).toHaveLength(1)
    expect(items()[0].name).toBe('Replacement bracket')
    expect(cache.has('geo-step')).toBe(true) // source bytes remain owned elsewhere
    expect(state().project.geometry[0].pendingModelItemId).toBe(replacement.itemId)
    expect(state().brepImportError).toBeNull()   // late stale cleanup did not mutate replacement UI
  })
})

// ── MODEL-ROW-CITIZEN batch 1 (defect e): wrap ambers bound ops ──────────────
// "Edit as model" flips the row's format to 'model' on adoption, re-routing the
// compute path to a DIFFERENT outline. A ready op bound to the import must go
// amber on wrap (via the shared outdateOpsReferencingGeo) so it re-derives or
// refuses honestly - it must not stay green over a stale toolpath.
// MUTATION proof: remove the outdateOpsReferencingGeo call in
// wrapImportedGeometryAsModelItem -> these go RED (op stays ready, toolpath kept).
describe('GEO-UNIFY Stage 4: wrapImportedGeometryAsModelItem — ambers bound ops (defect e)', () => {
  beforeEach(resetStore)

  function seedRowWithReadyOp(geometryId: string): void {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [stepRow()],
        setups: [{
          id: 'setup-1', name: 'Setup 1',
          wcs: {
            id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          stock: null, notes: '',
          operations: [{
            id: 'op-1', name: 'Contour', type: 'contour_2d', enabled: true, status: 'ready',
            toolId: 'tool-1', geometrySelections: [],
            heights: {
              clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
              topHeight: 0, topHeightMode: 'absolute', bottomHeight: -5, bottomHeightMode: 'absolute',
            },
            passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
            linking: {
              entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
              retractType: 'full', transitionType: 'safe_height',
            },
            params: { geometryId, loopIds: [] },
            toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }],
          }],
        } as never],
        activeSetupId: 'setup-1',
      },
    }))
  }

  const opStatus = () => state().project.setups[0].operations[0].status
  const opMoves = () => state().project.setups[0].operations[0].toolpathMoves

  it('a ready op DIRECTLY bound to the wrapped row goes outdated, toolpath cleared', async () => {
    seedRowWithReadyOp('geo-step')
    expect(opStatus()).toBe('ready')
    const res = await state().wrapImportedGeometryAsModelItem('geo-step')
    expect(res.ok).toBe(true)
    expect(opStatus()).toBe('outdated')
    expect(opMoves()).toBeUndefined() // stale import toolpath cleared
  })

  it("an '__all__' op is ambered too (it cuts everything, including the wrapped part)", async () => {
    seedRowWithReadyOp('__all__')
    const res = await state().wrapImportedGeometryAsModelItem('geo-step')
    expect(res.ok).toBe(true)
    expect(opStatus()).toBe('outdated')
  })

  it('the amber folds into the wrap ONE undo step (no extra history entry)', async () => {
    seedRowWithReadyOp('geo-step')
    await state().wrapImportedGeometryAsModelItem('geo-step')
    expect(opStatus()).toBe('outdated')      // ambered by the wrap
    // ONE undo fully reverts the wrap - my setups edit is folded into the wrap's
    // single existing set()/pushHistory, so it adds NO separate undo step: the row
    // returns to its pre-wrap format and the minted item is gone in one Ctrl+Z.
    // (op status after ANY undo is 'outdated' by pushHistory's regen-safety design,
    //  independent of this change, so it is not asserted here.)
    state().undo()
    expect(rowById('geo-step')!.format).toBe('step')
    expect(rowById('geo-step')!.pendingModelItemId).toBeUndefined()
    expect(items()).toHaveLength(0)
  })
})
